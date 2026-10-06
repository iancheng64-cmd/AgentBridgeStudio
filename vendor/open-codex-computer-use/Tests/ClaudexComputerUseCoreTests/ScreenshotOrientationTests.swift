import CoreGraphics
import XCTest
@testable import ClaudexComputerUseCore

final class ScreenshotOrientationTests: XCTestCase {
    private func canvas() -> CGContext {
        CGContext(data: nil, width: 8, height: 8, bitsPerComponent: 8, bytesPerRow: 32,
                  space: CGColorSpaceCreateDeviceRGB(),
                  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
    }

    func testScreenshotKeepsAsymmetricPixelsAndOverlayUsesTopLeftCoordinates() {
        let original = canvas()
        original.setFillColor(CGColor(red: 1, green: 0, blue: 0, alpha: 1))
        original.fill(CGRect(x: 0, y: 0, width: 8, height: 4))
        original.setFillColor(CGColor(red: 0, green: 0, blue: 1, alpha: 1))
        original.fill(CGRect(x: 0, y: 4, width: 8, height: 4))
        let image = original.makeImage()!
        let baseline = canvas()
        baseline.draw(image, in: CGRect(x: 0, y: 0, width: 8, height: 8))
        let result = canvas()
        VirtualCursor.drawScreenshotWithTopLeftOverlay(image, in: result, canvasRect: CGRect(x: 0, y: 0, width: 8, height: 8)) { overlay in
            overlay.setFillColor(CGColor(red: 0, green: 1, blue: 0, alpha: 1))
            overlay.fill(CGRect(x: 0, y: 0, width: 2, height: 2))
        }
        let before = baseline.data!.assumingMemoryBound(to: UInt8.self)
        let after = result.data!.assumingMemoryBound(to: UInt8.self)
        // The right-hand half contains no overlay: every top/bottom pixel must
        // exactly match the input. The former whole-context flip fails here.
        for y in 0..<8 {
            for x in 4..<8 {
                for channel in 0..<4 {
                    XCTAssertEqual(after[y * 32 + x * 4 + channel], before[y * 32 + x * 4 + channel])
                }
            }
        }
        // Compare against a native bottom-left drawing at y=6. This establishes
        // that overlay y=0 maps to the top edge without inverting the base image.
        let expected = canvas()
        expected.draw(image, in: CGRect(x: 0, y: 0, width: 8, height: 8))
        expected.setFillColor(CGColor(red: 0, green: 1, blue: 0, alpha: 1))
        expected.fill(CGRect(x: 0, y: 6, width: 2, height: 2))
        let expectedBytes = expected.data!.assumingMemoryBound(to: UInt8.self)
        for index in 0..<(32 * 8) { XCTAssertEqual(after[index], expectedBytes[index]) }
        XCTAssertEqual(result.ctm, .identity, "Overlay transform must not leak into later drawing")
    }
}
