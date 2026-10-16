import SwiftUI
import PhotosUI
import AVKit
import CompassCore

private enum StudioTheme {
    static let background = Color(red: 0.045, green: 0.037, blue: 0.080)
    static let surface = Color(red: 0.105, green: 0.082, blue: 0.155)
    static let violet = Color(red: 0.75, green: 0.53, blue: 1.0)
    static let soft = Color(red: 0.73, green: 0.68, blue: 0.82)
}

struct StudioView: View {
    @ObservedObject var store: StudioStore
    @State private var selection: [PhotosPickerItem] = []
    @State private var editing: Moment? = nil
    @State private var showClear = false
    @State private var showShare = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(alignment: .leading, spacing: 24) {
                    header
                    steps
                    if store.busy { progressCard }
                    if store.stage == 0 { setup }
                    else if store.stage == 1 { review }
                    else { finished }
                    Text("PRIVATE ALPHA 0.1  /  NATIVE IPHONE STUDIO")
                        .font(.system(size: 10, weight: .medium, design: .monospaced)).tracking(1.4)
                        .foregroundStyle(StudioTheme.soft).padding(.top, 12)
                }
                .padding(22)
            }
            .background {
                LinearGradient(colors: [StudioTheme.background, Color(red: 0.16, green: 0.07, blue: 0.23), StudioTheme.background], startPoint: .topLeading, endPoint: .bottomTrailing)
                    .ignoresSafeArea()
            }
            .safeAreaInset(edge: .bottom) { bottomBar }
            .toolbar(.hidden, for: .navigationBar)
            .tint(StudioTheme.violet)
            .sheet(item: $editing) { moment in
                MomentEditor(moment: moment, clips: store.project.clips) { updated in store.updateMoment(updated) }
            }
            .sheet(isPresented: $showShare) {
                if let url = store.previewURL { ShareController(url: url) }
            }
            .alert("Your edit is safe", isPresented: Binding(get: { store.error != nil }, set: { if !$0 { store.error = nil } })) {
                Button("Got it", role: .cancel) { store.error = nil }
            } message: { Text(store.error ?? "") }
            .alert("Concert Compass", isPresented: Binding(get: { store.notice != nil }, set: { if !$0 { store.notice = nil } })) {
                Button("Done", role: .cancel) { store.notice = nil }
            } message: { Text(store.notice ?? "") }
            .confirmationDialog("Delete this local project? Original videos in Photos will not be deleted.", isPresented: $showClear, titleVisibility: .visible) {
                Button("Delete local project", role: .destructive) { store.clear(); selection = [] }
            }
        }
    }
    private var header: some View {
        HStack {
            Image(systemName: "location.north.circle.fill").font(.title2).foregroundStyle(StudioTheme.violet)
            Text("CONCERT COMPASS").font(.system(size: 13, weight: .heavy)).tracking(1.5)
            Spacer()
            Menu {
                Button("Delete local project", role: .destructive) { showClear = true }
            } label: { Image(systemName: "ellipsis.circle").font(.title2) }
            .disabled(store.busy)
            .accessibilityLabel("Project options")
        }
        .padding(.bottom, 4)
    }
    private var steps: some View {
        HStack(spacing: 10) {
            ForEach(Array(["Create", "Review", "Keep"].enumerated()), id: \.offset) { index, title in
                Button {
                    if index == 0 || (index == 1 && store.project.plan != nil) || (index == 2 && store.previewURL != nil) { store.stage = index }
                } label: {
                    HStack(spacing: 7) {
                        Text("\(index + 1)").font(.caption.bold())
                            .frame(width: 24, height: 24).background(store.stage == index ? StudioTheme.violet : Color.white.opacity(0.06), in: Circle())
                            .foregroundStyle(store.stage == index ? StudioTheme.background : StudioTheme.soft)
                        Text(title).font(.subheadline.weight(.semibold))
                    }
                    .frame(maxWidth: .infinity).padding(.vertical, 12)
                    .background(store.stage == index ? StudioTheme.violet.opacity(0.10) : Color.clear, in: RoundedRectangle(cornerRadius: 16))
                    .overlay(RoundedRectangle(cornerRadius: 16).stroke(store.stage == index ? StudioTheme.violet.opacity(0.45) : Color.clear))
                }
                .buttonStyle(.plain).disabled(store.busy)
            }
        }
    }
    private var setup: some View {
        VStack(alignment: .leading, spacing: 24) {
            VStack(alignment: .leading, spacing: 10) {
                eyebrow("FROM CAMERA ROLL TO KEEP FOREVER")
                Text("Your night.\nWorth replaying.").font(.system(size: 42, weight: .heavy, design: .rounded)).lineSpacing(-1)
                Text("Choose your footage. Describe the feeling. Keep the moments that take you back.")
                    .font(.body).foregroundStyle(StudioTheme.soft)
            }
            card {
                VStack(alignment: .leading, spacing: 16) {
                    HStack {
                        Image(systemName: "photo.stack").font(.title).foregroundStyle(StudioTheme.violet)
                        VStack(alignment: .leading) {
                            Text("\(store.project.clips.count) clips in your studio").font(.headline)
                            Text("Up to 12 videos. Originals stay untouched.").font(.caption).foregroundStyle(StudioTheme.soft)
                        }
                    }
                    PhotosPicker(selection: $selection, maxSelectionCount: max(1, 12 - store.project.clips.count), selectionBehavior: .ordered, matching: .videos, preferredItemEncoding: .current) {
                        Label(store.project.clips.isEmpty ? "Choose concert videos" : "Add more footage", systemImage: "plus")
                            .font(.headline).frame(maxWidth: .infinity).padding(16)
                            .background(StudioTheme.violet, in: RoundedRectangle(cornerRadius: 14)).foregroundStyle(StudioTheme.background)
                    }
                    .disabled(store.busy || store.project.clips.count >= 12)
                    .onChange(of: selection) { _, items in
                        guard !items.isEmpty else { return }
                        store.importMovies(items); selection = []
                    }
                    if !store.project.clips.isEmpty {
                        ForEach(store.project.clips) { clip in
                            HStack {
                                Image(systemName: clip.hasAudio ? "waveform" : "speaker.slash")
                                Text(clip.name).lineLimit(1)
                                Spacer()
                                Text(clock(clip.duration)).monospacedDigit()
                            }.font(.caption).foregroundStyle(StudioTheme.soft)
                        }
                    }
                }
            }
            card {
                VStack(alignment: .leading, spacing: 14) {
                    Text("Tell your editor the feeling.").font(.title3.bold())
                    TextField("Cinematic, soft transitions, keep the music...", text: store.setting(\.prompt), axis: .vertical)
                        .lineLimit(3...5).padding(14).background(.black.opacity(0.18), in: RoundedRectangle(cornerRadius: 12))
                        .accessibilityLabel("Edit prompt")
                    Button("Apply my direction", systemImage: "sparkles") { store.interpretPrompt() }
                        .font(.subheadline.bold()).disabled(store.busy)
                    if !store.explanation.isEmpty {
                        Text(store.explanation.joined(separator: "\n"))
                            .font(.caption).foregroundStyle(StudioTheme.soft).textSelection(.enabled)
                    }
                }
            }
            settings
            Text("Footage is processed in this app, not sent to our servers. iCloud imports and Photos syncing use Apple services. Nothing is posted automatically.")
                .font(.caption).foregroundStyle(StudioTheme.soft)
        }
    }
    private var settings: some View {
        card {
            VStack(alignment: .leading, spacing: 18) {
                Text("Make it yours").font(.title3.bold())
                Picker("Edit format", selection: store.setting(\.mode)) {
                    Text("Highlight Reel").tag(EditMode.highlight)
                    Text("Trailer").tag(EditMode.trailer)
                }.pickerStyle(.segmented)
                HStack {
                    Text("Feel").foregroundStyle(StudioTheme.soft)
                    Spacer()
                    Picker("Feel", selection: store.setting(\.style)) {
                        ForEach(EditStyle.allCases, id: \.self) { Text($0.label).tag($0) }
                    }.pickerStyle(.menu)
                }
                HStack(spacing: 8) {
                    ForEach([15.0, 30, 45, 60], id: \.self) { seconds in
                        Button {
                            store.setting(\.targetSeconds).wrappedValue = seconds
                        } label: {
                            Text("\(Int(seconds))s").font(.subheadline.bold()).frame(maxWidth: .infinity).padding(.vertical, 12)
                                .background(store.project.settings.targetSeconds == seconds ? StudioTheme.violet.opacity(0.24) : Color.white.opacity(0.04), in: RoundedRectangle(cornerRadius: 12))
                        }.buttonStyle(.plain)
                    }
                }
                Picker("Transitions", selection: store.setting(\.transitions)) {
                    Text("Purposeful auto").tag(TransitionPreference.automatic)
                    Text("Cuts only").tag(TransitionPreference.cuts)
                    Text("Soft dissolves").tag(TransitionPreference.dissolves)
                }.pickerStyle(.menu)
                Toggle(isOn: store.setting(\.gentleCleanup)) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Gentle audio cleanup")
                        Text("Softens rumble. Does not remove crowd voices.").font(.caption).foregroundStyle(StudioTheme.soft)
                    }
                }
                Toggle(isOn: store.setting(\.stabilize)) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Gentle stabilization (experimental)")
                        Text("Small-shake correction with a modest crop.").font(.caption).foregroundStyle(StudioTheme.soft)
                    }
                }
                if store.project.clips.contains(where: \.hasAudio) {
                    Picker("Audio bed", selection: store.setting(\.masterAudioClipID)) {
                        Text("Each clip's original audio").tag(Optional<UUID>.none)
                        ForEach(store.project.clips.filter(\.hasAudio)) { clip in
                            Text("Continuous: \(clip.name)").tag(Optional(clip.id))
                        }
                    }.pickerStyle(.menu)
                    Text("A continuous source plays from its start and must cover the whole reel. It is not automatically lip-synced to other shots.")
                        .font(.caption).foregroundStyle(StudioTheme.soft)
                }
            }
            .disabled(store.busy)
        }
    }
    private var review: some View {
        VStack(alignment: .leading, spacing: 20) {
            eyebrow("THE MOMENTS THAT MAKE THE NIGHT")
            Text("Your first cut.").font(.system(size: 38, weight: .heavy, design: .rounded))
            if let plan = store.project.plan {
                Text("\(plan.moments.filter(\.approved).count) moments  /  \(String(format: "%.1f", Timeline.duration(plan))) seconds")
                    .font(.headline).foregroundStyle(StudioTheme.violet)
                Text("Watch, trim, replace, reorder or reject. A lock protects a moment when you regenerate.")
                    .foregroundStyle(StudioTheme.soft)
                ForEach(plan.moments) { moment in
                    if let clip = store.project.clips.first(where: { $0.id == moment.clipID }) {
                        momentCard(moment, clip: clip)
                    }
                }
                DisclosureGroup("What the editor used") {
                    Text(([plan.director] + plan.warnings + store.project.clips.flatMap(\.warnings)).joined(separator: "\n\n"))
                        .font(.caption).foregroundStyle(StudioTheme.soft).padding(.top, 8)
                }.font(.subheadline)
                Toggle("I reviewed these selections", isOn: $store.reviewed).font(.subheadline.weight(.medium))
                Button("Try a different edit", systemImage: "arrow.triangle.2.circlepath") { store.planReel() }
                    .font(.subheadline.bold()).disabled(store.busy)
            }
        }
    }
    private func momentCard(_ moment: Moment, clip: MediaClip) -> some View {
        card {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text(moment.role.rawValue.uppercased()).font(.caption2.bold()).tracking(1.4).foregroundStyle(StudioTheme.violet)
                    Spacer()
                    if moment.locked { Image(systemName: "lock.fill").accessibilityLabel("Locked") }
                    Text(moment.approved ? "IN YOUR REEL" : "REJECTED").font(.system(size: 10, weight: .semibold, design: .monospaced))
                        .foregroundStyle(moment.approved ? StudioTheme.soft : Color.orange)
                }
                HStack(alignment: .top, spacing: 14) {
                    MomentThumbnail(clip: clip, moment: moment).frame(width: 72, height: 100).clipped().clipShape(RoundedRectangle(cornerRadius: 10))
                    VStack(alignment: .leading, spacing: 7) {
                        Text(clip.name).font(.headline)
                        Text("\(clock(moment.start)) to \(clock(moment.end))  /  \(String(format: "%.1f", moment.duration))s")
                            .font(.caption).monospacedDigit().foregroundStyle(StudioTheme.soft)
                        Text(moment.reason).font(.caption).foregroundStyle(StudioTheme.soft)
                        Button("Watch / trim / replace", systemImage: "play.circle.fill") { editing = moment }
                            .font(.caption.bold()).padding(.top, 2)
                    }
                }
                HStack(spacing: 18) {
                    Button(moment.locked ? "Unlock" : "Lock", systemImage: moment.locked ? "lock.open" : "lock") {
                        var changed = moment; changed.locked.toggle(); store.updateMoment(changed)
                    }
                    Button(moment.approved ? "Reject" : "Restore", systemImage: moment.approved ? "minus.circle" : "plus.circle") {
                        var changed = moment; changed.approved.toggle(); store.updateMoment(changed)
                    }
                    Spacer()
                    Button { store.move(moment.id, direction: -1) } label: { Image(systemName: "arrow.up") }.accessibilityLabel("Move earlier")
                    Button { store.move(moment.id, direction: 1) } label: { Image(systemName: "arrow.down") }.accessibilityLabel("Move later")
                }.font(.caption.bold())
            }
        }.opacity(moment.approved ? 1 : 0.65).disabled(store.busy)
    }
    private var finished: some View {
        VStack(alignment: .leading, spacing: 20) {
            eyebrow("THE NIGHT, READY TO RELIVE")
            Text("Keep the feeling.").font(.system(size: 38, weight: .heavy, design: .rounded))
            Text("This is the complete rendered reel, not just its first clip. Watch it with sound before saving.")
                .foregroundStyle(StudioTheme.soft)
            if let url = store.previewURL {
                NativePlayer(url: url, start: 0, end: nil)
                    .aspectRatio(9.0 / 16, contentMode: .fit).clipShape(RoundedRectangle(cornerRadius: 22))
                HStack {
                    Label("1080 x 1920", systemImage: "rectangle.portrait")
                    Spacer()
                    Text("H.264 MP4")
                }.font(.caption).foregroundStyle(StudioTheme.soft)
                Button("Share your reel", systemImage: "square.and.arrow.up") { showShare = true }
                    .font(.headline).disabled(store.busy)
                Button("Back to my edit", systemImage: "arrow.left") { store.stage = 1 }
                    .font(.subheadline).disabled(store.busy)
            } else {
                Text("A complete preview has not been rendered yet.").foregroundStyle(StudioTheme.soft)
                Button("Return to review") { store.stage = 1 }
            }
        }
    }
    private var progressCard: some View {
        card {
            VStack(alignment: .leading, spacing: 12) {
                Text(store.status).font(.headline)
                ProgressView(value: store.progress).tint(StudioTheme.violet)
                Text("Keep this app open. Switching away stops this alpha's render, but preserves your edit.")
                    .font(.caption).foregroundStyle(StudioTheme.soft)
                Button("Stop safely", role: .cancel) { store.cancel() }.font(.caption.bold())
            }
        }
    }
    private var bottomBar: some View {
        VStack(spacing: 0) {
            Button {
                if store.stage == 0 { store.planReel() }
                else if store.stage == 1 { store.renderPreview() }
                else { store.saveToPhotos() }
            } label: {
                HStack {
                    Text(store.stage == 0 ? "Plan my reel" : store.stage == 1 ? "Render full preview" : "Save to Photos")
                    Spacer()
                    Image(systemName: store.stage == 2 ? "square.and.arrow.down" : "arrow.right")
                }
                .font(.headline).padding(19)
                .foregroundStyle(StudioTheme.background).background(StudioTheme.violet, in: RoundedRectangle(cornerRadius: 18))
            }
            .disabled(store.busy || (store.stage == 0 && store.project.clips.isEmpty) || (store.stage == 1 && !store.reviewed) || (store.stage == 2 && store.previewURL == nil))
            .opacity(store.busy || (store.stage == 1 && !store.reviewed) ? 0.5 : 1)
        }
        .padding(.horizontal, 22).padding(.top, 12).padding(.bottom, 8)
        .background(StudioTheme.background.opacity(0.96))
    }
    private func eyebrow(_ text: String) -> some View {
        Text(text).font(.system(size: 10, weight: .heavy)).tracking(2.2).foregroundStyle(StudioTheme.violet)
    }
    private func card<Content: View>(@ViewBuilder _ content: () -> Content) -> some View {
        content().frame(maxWidth: .infinity, alignment: .leading).padding(18)
            .background(StudioTheme.surface.opacity(0.85), in: RoundedRectangle(cornerRadius: 22))
            .overlay(RoundedRectangle(cornerRadius: 22).stroke(StudioTheme.violet.opacity(0.18)))
    }
}

private func clock(_ time: Double) -> String {
    String(format: "%d:%04.1f", Int(time) / 60, time.truncatingRemainder(dividingBy: 60))
}

struct MomentThumbnail: View {
    let clip: MediaClip
    let moment: Moment
    @State private var image: UIImage? = nil
    var body: some View {
        ZStack {
            StudioTheme.surface
            if let image { Image(uiImage: image).resizable().scaledToFill() }
            else { Image(systemName: "film").foregroundStyle(StudioTheme.soft) }
        }
        .task(id: "\(moment.clipID)-\(moment.start)") {
            guard let url = try? NativeFiles.source(clip.fileName) else { return }
            let generator = AVAssetImageGenerator(asset: AVURLAsset(url: url))
            generator.appliesPreferredTrackTransform = true
            generator.maximumSize = CGSize(width: 240, height: 320)
            if let frame = try? await generator.image(at: CMTime(seconds: clip.mediaStart + moment.start, preferredTimescale: 600)) { image = UIImage(cgImage: frame.image) }
        }
    }
}

struct MomentEditor: View {
    @Environment(\.dismiss) private var dismiss
    @State var moment: Moment
    let clips: [MediaClip]
    let onSave: (Moment) -> Void
    @State private var error: String? = nil
    private var clip: MediaClip? { clips.first { $0.id == moment.clipID } }
    var body: some View {
        NavigationStack {
            Form {
                if let clip, let url = try? NativeFiles.source(clip.fileName) {
                    NativePlayer(url: url, start: clip.mediaStart + moment.start, end: clip.mediaStart + moment.end)
                        .frame(height: 310).listRowInsets(EdgeInsets())
                    Section("Source and trim") {
                        Picker("Replace source", selection: $moment.clipID) {
                            ForEach(clips) { Text($0.name).tag($0.id) }
                        }
                        .onChange(of: moment.clipID) { _, _ in
                            moment.start = 0; moment.duration = min(moment.duration, self.clip?.duration ?? moment.duration)
                        }
                        TextField("Start (seconds)", value: $moment.start, format: .number.precision(.fractionLength(2)))
                            .keyboardType(.decimalPad)
                        TextField("Length (seconds)", value: $moment.duration, format: .number.precision(.fractionLength(2)))
                            .keyboardType(.decimalPad)
                        Text("Source: \(clock(clip.duration)). Replacing a source is an explicit manual choice.")
                            .font(.caption).foregroundStyle(.secondary)
                    }.disabled(moment.locked)
                    Section("Keep the performer in frame") {
                        Text("Horizontal focus").font(.caption)
                        Slider(value: $moment.focusX, in: 0...1).accessibilityLabel("Horizontal framing")
                        Text("Vertical focus").font(.caption)
                        Slider(value: $moment.focusY, in: 0...1).accessibilityLabel("Vertical framing")
                        Text("The player above shows the source. Check the final 9:16 crop in the full rendered preview. Automatic performer tracking is not in this build.")
                            .font(.caption).foregroundStyle(.secondary)
                    }.disabled(moment.locked)
                    Toggle("Mute this clip's source audio", isOn: $moment.muted)
                    Toggle("Lock this moment on regeneration", isOn: $moment.locked)
                    Toggle("Include in the reel", isOn: $moment.approved)
                    if let error { Text(error).foregroundStyle(.orange) }
                }
            }
            .navigationTitle("Make this moment yours").navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Keep") {
                        guard let clip, moment.start.isFinite, moment.duration.isFinite, moment.start >= 0,
                              moment.duration >= 0.1, moment.end <= clip.duration + 0.002 else {
                            error = "Keep the trim inside this clip, with a minimum length of 0.1 seconds."; return
                        }
                        onSave(moment); dismiss()
                    }
                }
            }
        }
        .tint(StudioTheme.violet).preferredColorScheme(.dark)
    }
}

struct NativePlayer: UIViewControllerRepresentable {
    let url: URL
    let start: Double
    let end: Double?
    func makeCoordinator() -> Coordinator { Coordinator() }
    func makeUIViewController(context: Context) -> AVPlayerViewController {
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .moviePlayback)
        let controller = AVPlayerViewController()
        controller.showsPlaybackControls = true
        controller.videoGravity = .resizeAspect
        context.coordinator.update(controller, url: url, start: start, end: end)
        return controller
    }
    func updateUIViewController(_ controller: AVPlayerViewController, context: Context) {
        context.coordinator.update(controller, url: url, start: start, end: end)
    }
    static func dismantleUIViewController(_ controller: AVPlayerViewController, coordinator: Coordinator) { coordinator.clear() }
    final class Coordinator {
        private var key = ""
        private var player: AVPlayer? = nil
        private var boundary: Any? = nil
        func update(_ controller: AVPlayerViewController, url: URL, start: Double, end: Double?) {
            let nextKey = "\(url.path)|\(start)|\(end ?? -1)"
            guard key != nextKey else { return }
            clear(); key = nextKey
            let player = AVPlayer(url: url); self.player = player; controller.player = player
            let safeStart = start.isFinite ? max(0, start) : 0
            player.seek(to: CMTime(seconds: safeStart, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
            if let end, end.isFinite, end > safeStart {
                boundary = player.addBoundaryTimeObserver(forTimes: [NSValue(time: CMTime(seconds: end, preferredTimescale: 600))], queue: .main) { [weak player] in
                    player?.pause()
                    player?.seek(to: CMTime(seconds: safeStart, preferredTimescale: 600), toleranceBefore: .zero, toleranceAfter: .zero)
                }
            }
        }
        func clear() {
            player?.pause()
            if let boundary { player?.removeTimeObserver(boundary) }
            boundary = nil; player = nil
        }
    }
}

struct ShareController: UIViewControllerRepresentable {
    let url: URL
    func makeUIViewController(context: Context) -> UIActivityViewController { UIActivityViewController(activityItems: [url], applicationActivities: nil) }
    func updateUIViewController(_ controller: UIActivityViewController, context: Context) {}
}
