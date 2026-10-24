import Foundation
import CoreTransferable
import UniformTypeIdentifiers
import CompassCore

struct ProjectDocument: Codable {
    var version = 1
    var clips: [MediaClip] = []
    var settings = EditSettings()
    var plan: EditPlan? = nil
    var exportFileName: String? = nil
    var revision: UInt64 = 0
    var lastInterpretedPrompt: String? = nil
}

enum NativeFiles {
    static func root() throws -> URL {
        let base = try FileManager.default.url(for: .applicationSupportDirectory, in: .userDomainMask,
                                               appropriateFor: nil, create: true)
        var root = base.appendingPathComponent("ConcertCompass", isDirectory: true)
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        var values = URLResourceValues(); values.isExcludedFromBackup = true
        try root.setResourceValues(values)
        return root
    }
    static func directory(_ name: String) throws -> URL {
        let url = try root().appendingPathComponent(name, isDirectory: true)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
        return url
    }
    static func source(_ name: String) throws -> URL {
        guard !name.isEmpty, name == URL(fileURLWithPath: name).lastPathComponent,
              !name.contains(".."), !name.contains("\\") else { throw CompassError.invalid("Invalid source reference.") }
        let url = try directory("Sources").appendingPathComponent(name)
        guard FileManager.default.fileExists(atPath: url.path) else { throw CompassError.invalid("A source video is missing. Reimport that clip; the original in Photos is unchanged.") }
        return url
    }
    static func export(_ name: String) throws -> URL {
        guard name == URL(fileURLWithPath: name).lastPathComponent, !name.contains("..") else { throw CompassError.invalid("Invalid export reference.") }
        return try directory("Exports").appendingPathComponent(name)
    }
    static func save(_ document: ProjectDocument) throws {
        let data = try JSONEncoder().encode(document)
        try data.write(to: root().appendingPathComponent("project.json"), options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }
    static func restore() throws -> ProjectDocument {
        let path = try root().appendingPathComponent("project.json")
        guard FileManager.default.fileExists(atPath: path.path) else { return ProjectDocument() }
        let document = try JSONDecoder().decode(ProjectDocument.self, from: Data(contentsOf: path))
        guard document.version == 1 else { throw CompassError.invalid("This saved project uses a newer format. Nothing has been deleted.") }
        return document
    }
    static func clearProject() throws {
        let root = try root()
        try FileManager.default.removeItem(at: root)
    }
    static func removeIncompleteRenders() throws {
        let cache = try directory("Working")
        for file in try FileManager.default.contentsOfDirectory(at: cache, includingPropertiesForKeys: nil) {
            try FileManager.default.removeItem(at: file)
        }
    }
}

struct ImportedMovie: Transferable {
    let url: URL
    static var transferRepresentation: some TransferRepresentation {
        FileRepresentation(importedContentType: .movie) { received in
            let values = try received.file.resourceValues(forKeys: [.fileSizeKey])
            guard (values.fileSize ?? 0) <= 1_500_000_000 else {
                throw CompassError.invalid("This alpha accepts individual videos up to 1.5 GB. Choose a shorter clip.")
            }
            let sourceExtension = received.file.pathExtension.lowercased()
            let ext = ["mov", "mp4", "m4v"].contains(sourceExtension) ? sourceExtension : "mov"
            let target = try NativeFiles.directory("Sources").appendingPathComponent(UUID().uuidString + "." + ext)
            do {
                try FileManager.default.copyItem(at: received.file, to: target)
                try FileManager.default.setAttributes([.protectionKey: FileProtectionType.completeUntilFirstUserAuthentication], ofItemAtPath: target.path)
                return ImportedMovie(url: target)
            } catch {
                try? FileManager.default.removeItem(at: target)
                throw error
            }
        }
    }
}
