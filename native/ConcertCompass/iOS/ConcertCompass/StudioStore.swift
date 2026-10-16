import SwiftUI
import PhotosUI
import Photos
import AVFoundation
import Combine
import CompassCore

@MainActor
final class StudioStore: ObservableObject {
    @Published var project = ProjectDocument()
    @Published var stage = 0
    @Published var busy = false
    @Published var progress = 0.0
    @Published var status = "Everything stays in your private studio."
    @Published var error: String? = nil
    @Published var notice: String? = nil
    @Published var explanation: [String] = []
    @Published var reviewed = false
    @Published var shareURL: URL? = nil
    private var task: Task<Void, Never>? = nil
    private let analyzer = NativeAnalyzer()
    private let renderer = NativeRenderer()
    private let director = OnDeviceDirector()
    private var operationID = UUID()
    private var directorName = "On-device rules + signal-based planner"

    init() {
        do {
            project = try NativeFiles.restore()
            try NativeFiles.removeIncompleteRenders()
            if project.plan != nil { stage = 1 }
            if let name = project.exportFileName, let url = try? NativeFiles.export(name), FileManager.default.fileExists(atPath: url.path) { stage = 2 }
        } catch { self.error = "Your last session could not be fully restored: \(error.localizedDescription). No original Photos videos were changed." }
    }
    var previewURL: URL? {
        guard let name = project.exportFileName, let url = try? NativeFiles.export(name), FileManager.default.fileExists(atPath: url.path) else { return nil }
        return url
    }
    func setting<T>(_ key: WritableKeyPath<EditSettings, T>) -> Binding<T> {
        Binding(get: { self.project.settings[keyPath: key] }, set: {
            self.project.settings[keyPath: key] = $0
            self.project.plan?.settings = self.project.settings
            self.invalidatePreview(); self.persist()
        })
    }
    func importMovies(_ items: [PhotosPickerItem]) {
        guard !busy, !items.isEmpty else { return }
        guard project.clips.count + items.count <= 12 else { error = "This alpha accepts 12 clips per project. Clear the project to start another."; return }
        begin("Importing your concert clips")
        let operation = operationID
        task = Task {
            defer { finish() }
            for (index, item) in items.enumerated() {
                var imported: ImportedMovie? = nil
                do {
                    try Task.checkCancellation()
                    status = "Importing clip \(index + 1)/\(items.count). iCloud originals may take a moment."
                    guard let movie = try await item.loadTransferable(type: ImportedMovie.self) else {
                        throw CompassError.invalid("This video could not be imported. Make sure the original is downloaded in Photos.")
                    }
                    imported = movie
                    try Task.checkCancellation()
                    let clip = try await analyzer.analyze(url: movie.url, name: "Concert clip \(project.clips.count + 1)") { local in
                        Task { @MainActor in
                            guard self.busy, self.operationID == operation else { return }
                            self.progress = (Double(index) + local) / Double(items.count)
                            self.status = "Analyzing clip \(index + 1)/\(items.count)"
                        }
                    }
                    try Task.checkCancellation()
                    project.clips.append(clip)
                    invalidatePreview(); persist()
                } catch is CancellationError {
                    if let imported { try? FileManager.default.removeItem(at: imported.url) }
                    status = "Stopped. Imported clips and edits are saved."
                    return
                } catch {
                    if let imported { try? FileManager.default.removeItem(at: imported.url) }
                    self.error = "Clip \(index + 1): \(friendly(error))"
                }
            }
            status = "\(project.clips.count) clips ready. Tell the editor what you want."
        }
    }
    func interpretPrompt() {
        guard !busy else { return }
        begin("Reading your edit direction")
        let settings = project.settings
        task = Task {
            defer { finish() }
            let result = await director.interpret(settings)
            guard !Task.isCancelled else { status = "Cancelled. Your settings are unchanged."; return }
            project.settings = result.settings; project.plan?.settings = result.settings
            project.lastInterpretedPrompt = settings.prompt
            explanation = result.explanation; directorName = result.engine
            invalidatePreview(); persist(); status = "Review the settings below before planning."
        }
    }
    func planReel() {
        guard !busy else { return }
        begin("Choosing moments and building the story")
        let clips = project.clips, settings = project.settings, previous = project.plan
        project.revision &+= 1
        let seed: UInt64 = previous == nil ? 0 : project.revision
        task = Task {
            defer { finish() }
            do {
                var effective = settings
                if !settings.prompt.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && project.lastInterpretedPrompt != settings.prompt {
                    let result = await director.interpret(settings)
                    try Task.checkCancellation()
                    effective = result.settings; explanation = result.explanation; directorName = result.engine
                    project.lastInterpretedPrompt = settings.prompt
                }
                let requestSettings = effective
                let worker = Task.detached(priority: .userInitiated) { try Planner.propose(clips: clips, settings: requestSettings, previous: previous, seed: seed) }
                var plan = try await withTaskCancellationHandler { try await worker.value } onCancel: { worker.cancel() }
                try Task.checkCancellation()
                plan.director = directorName
                project.plan = plan; project.settings = plan.settings
                invalidatePreview(); stage = 1; persist()
                status = "Your suggested edit is ready. Review the trims before rendering."
            } catch is CancellationError { status = "Cancelled. Your previous edit is safe." }
            catch { self.error = friendly(error) }
        }
    }
    func updateMoment(_ moment: Moment) {
        guard !busy, var plan = project.plan, let index = plan.moments.firstIndex(where: { $0.id == moment.id }) else { return }
        plan.moments[index] = moment
        do {
            // Rejection of every moment is allowed in the editor, but not at render time.
            if plan.moments.contains(where: \.approved) { try Timeline.validate(plan, clips: project.clips) }
            project.plan = plan; invalidatePreview(); persist()
        } catch { self.error = friendly(error) }
    }
    func move(_ id: UUID, direction: Int) {
        guard !busy, var plan = project.plan, let i = plan.moments.firstIndex(where: { $0.id == id }) else { return }
        let j = i + direction
        guard plan.moments.indices.contains(j) else { return }
        plan.moments.swapAt(i, j); project.plan = plan; invalidatePreview(); persist()
    }
    func renderPreview() {
        guard !busy, reviewed, let plan = project.plan else { error = "Review your proposed moments before rendering."; return }
        begin("Preparing your full reel")
        let operation = operationID
        let clips = project.clips
        task = Task {
            defer { finish() }
            do {
                let result = try await renderer.render(plan: plan, clips: clips) { progress, status in
                    Task { @MainActor in
                        guard self.busy, self.operationID == operation else { return }
                        self.progress = progress; self.status = status
                    }
                }
                try Task.checkCancellation()
                let old = project.exportFileName
                project.exportFileName = result.url.lastPathComponent
                project.plan?.warnings.append(contentsOf: result.warnings)
                if let old, old != result.url.lastPathComponent, let path = try? NativeFiles.export(old) { try? FileManager.default.removeItem(at: path) }
                stage = 2; persist(); status = "Watch the complete reel, then save or share."
            } catch is CancellationError { status = "Export stopped. Your selections are saved; retry while the app stays open." }
            catch { self.error = friendly(error); status = "Export did not finish. Your edit is saved." }
        }
    }
    func saveToPhotos() {
        guard !busy, let url = previewURL else { return }
        begin("Saving your finished reel")
        task = Task {
            defer { finish() }
            do {
                let permission = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
                guard permission == .authorized || permission == .limited else {
                    throw CompassError.invalid("Photos access was not granted. The reel is still here; use Share or enable Add Photos access in Settings.")
                }
                try await PHPhotoLibrary.shared().performChanges {
                    PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
                }
                notice = "Saved to Photos. Your original videos were not changed."
                status = "Saved. Keep the night."
            } catch { self.error = friendly(error) }
        }
    }
    func cancel() {
        task?.cancel(); persist()
    }
    func clear() {
        guard !busy else { return }
        do {
            try NativeFiles.clearProject(); project = ProjectDocument(); stage = 0; explanation = []; reviewed = false
            status = "Start a new night. Originals in Photos were not deleted."
        } catch { self.error = friendly(error) }
    }
    func persist() {
        do { try NativeFiles.save(project) }
        catch { self.error = "This edit could not be saved locally: \(friendly(error))" }
    }
    private func begin(_ message: String) {
        operationID = UUID(); busy = true; progress = 0; status = message
        UIApplication.shared.isIdleTimerDisabled = true
    }
    private func finish() {
        busy = false; task = nil; UIApplication.shared.isIdleTimerDisabled = false
    }
    private func invalidatePreview() {
        if let name = project.exportFileName, let url = try? NativeFiles.export(name) { try? FileManager.default.removeItem(at: url) }
        project.exportFileName = nil; reviewed = false
    }
    private func friendly(_ error: Error) -> String {
        let ns = error as NSError
        if ns.domain == NSCocoaErrorDomain && ns.code == NSFileWriteOutOfSpaceError { return "Your phone needs more free space to finish. The originals are unchanged." }
        return error.localizedDescription
    }
}
