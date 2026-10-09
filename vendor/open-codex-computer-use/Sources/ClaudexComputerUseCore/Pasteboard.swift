import AppKit
import Foundation

struct PasteboardSnapshot {
    struct Item {
        let entries: [(type: NSPasteboard.PasteboardType, data: Data)]
    }

    let items: [Item]
    let changeCount: Int

    init(pasteboard: NSPasteboard = .general) {
        self.changeCount = pasteboard.changeCount
        self.items = (pasteboard.pasteboardItems ?? []).map { item in
            Item(
                entries: item.types.compactMap { type in
                    guard let data = item.data(forType: type) else {
                        return nil
                    }
                    return (type: type, data: data)
                }
            )
        }
    }

    func restore(to pasteboard: NSPasteboard = .general) {
        pasteboard.clearContents()
        guard !items.isEmpty else {
            return
        }

        let restoredItems = items.map { snapshotItem in
            let item = NSPasteboardItem()
            for entry in snapshotItem.entries {
                item.setData(entry.data, forType: entry.type)
            }
            return item
        }
        pasteboard.writeObjects(restoredItems)
    }
}

enum PasteboardInjector {
    static func pasteText(
        _ text: String,
        into pid: pid_t,
        mode: InteractionDeliveryMode,
        restoreFocus: Bool
    ) throws -> (clipboardRestored: Bool, frontmostBefore: FrontmostAppState, frontmostAfter: FrontmostAppState) {
        let pasteboard = NSPasteboard.general
        let snapshot = PasteboardSnapshot(pasteboard: pasteboard)
        pasteboard.clearContents()
        pasteboard.setString(text, forType: .string)

        do {
            let delivery = try InteractionDelivery.perform(
                targetPID: pid,
                mode: mode,
                restoreFocus: restoreFocus
            ) {
                try KeyInjector.pressKey(
                    pid: pid,
                    key: "super+v",
                    deliveryMode: .background,
                    restoreFocus: false
                )
            }
            snapshot.restore(to: pasteboard)
            return (
                clipboardRestored: true,
                frontmostBefore: delivery.frontmostBefore,
                frontmostAfter: delivery.frontmostAfter
            )
        } catch {
            snapshot.restore(to: pasteboard)
            throw error
        }
    }
}
