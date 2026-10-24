import SwiftUI

@main
struct ConcertCompassApp: App {
    @StateObject private var store = StudioStore()
    @Environment(\.scenePhase) private var scenePhase
    var body: some Scene {
        WindowGroup {
            StudioView(store: store)
                .preferredColorScheme(.dark)
                .onChange(of: scenePhase) { _, phase in
                    if phase == .background { store.cancel() }
                    if phase != .active { store.persist() }
                }
        }
    }
}
