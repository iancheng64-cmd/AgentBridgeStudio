import CoreGraphics
import Foundation

public enum VirtualCursorStyle: String, Codable {
    case crosshair
    case secondCursor
    case ghostArrow
}

public struct VirtualCursorDrawMark {
    public let point: CGPoint
    public let kind: String
    public let accuracy: VirtualCursorAccuracy
    public let timestamp: Date

    public init(
        point: CGPoint,
        kind: String,
        accuracy: VirtualCursorAccuracy,
        timestamp: Date
    ) {
        self.point = point
        self.kind = kind
        self.accuracy = accuracy
        self.timestamp = timestamp
    }
}

public enum VirtualCursorRenderer {
    private struct Accent {
        let stroke: CGColor
        let fill: CGColor
        let halo: CGColor
        let soft: CGColor
    }

    public static func draw(
        in context: CGContext,
        config: VirtualCursorConfig,
        marks: [VirtualCursorDrawMark],
        currentPoint: CGPoint? = nil,
        currentTilt: CGFloat = 0,
        now: Date = Date()
    ) {
        guard !marks.isEmpty else {
            return
        }

        let effectiveMarks = effectiveMarks(marks, currentPoint: currentPoint)
        guard let current = effectiveMarks.last else {
            return
        }

        if config.showTrail {
            drawTrail(
                in: context,
                marks: effectiveMarks,
                style: config.style
            )
        }

        let accent = accent(for: current.kind)
        let pulse = pulseAmount(age: now.timeIntervalSince(current.timestamp))
        switch current.accuracy {
        case .coordinate, .semantic:
            switch config.style {
            case .crosshair:
                drawCrosshair(
                    in: context,
                    mark: current,
                    accent: accent,
                    pulse: pulse
                )
            case .secondCursor:
                drawSecondCursor(
                    in: context,
                    point: current.point,
                    accent: accent,
                    pulse: pulse,
                    tilt: currentTilt,
                    pressed: isPressAction(current.kind)
                )
            case .ghostArrow:
                drawGhostArrow(
                    in: context,
                    point: current.point,
                    accent: accent,
                    pulse: pulse,
                    tilt: currentTilt
                )
            }
        case .approximate:
            if config.mode.rendersOnDesktop, config.style != .crosshair {
                drawApproximatePointer(
                    in: context,
                    point: current.point,
                    accent: accent,
                    pulse: pulse,
                    tilt: currentTilt,
                    style: config.style
                )
            } else {
                drawApproximateAnchor(
                    in: context,
                    point: current.point,
                    accent: accent,
                    pulse: pulse
                )
            }
        case .inferred:
            drawKeyboardBadge(
                in: context,
                point: current.point,
                accent: accent,
                pulse: pulse
            )
        }
    }

    private static func effectiveMarks(
        _ marks: [VirtualCursorDrawMark],
        currentPoint: CGPoint?
    ) -> [VirtualCursorDrawMark] {
        guard let currentPoint, var last = marks.last else {
            return marks
        }
        last = VirtualCursorDrawMark(
            point: currentPoint,
            kind: last.kind,
            accuracy: last.accuracy,
            timestamp: last.timestamp
        )
        return Array(marks.dropLast()) + [last]
    }

    private static func drawTrail(
        in context: CGContext,
        marks: [VirtualCursorDrawMark],
        style: VirtualCursorStyle
    ) {
        guard marks.count > 1 else {
            return
        }

        context.saveGState()
        context.setAllowsAntialiasing(true)
        context.setLineCap(.round)
        context.setLineJoin(.round)

        let lineWidth: CGFloat
        switch style {
        case .crosshair:
            lineWidth = 3
        case .secondCursor:
            lineWidth = 2.4
        case .ghostArrow:
            lineWidth = 2.8
        }

        for (index, pair) in zip(marks.indices, zip(marks, marks.dropFirst())) {
            guard pair.0.accuracy.drawsDirectionalPointer, pair.1.accuracy.drawsDirectionalPointer else {
                continue
            }
            let alpha = CGFloat(index + 1) / CGFloat(marks.count + 1)
            let accent = accent(for: pair.1.kind)
            context.setStrokeColor(withAlpha(accent.stroke, alpha: 0.10 + (alpha * 0.28)))
            context.setLineWidth(lineWidth)
            context.beginPath()
            context.move(to: pair.0.point)
            context.addLine(to: pair.1.point)
            context.strokePath()
        }

        for (index, mark) in marks.dropLast().enumerated() {
            let alpha = CGFloat(index + 1) / CGFloat(max(1, marks.count))
            let accent = accent(for: mark.kind)
            let radius: CGFloat
            switch mark.accuracy {
            case .coordinate, .semantic:
                switch style {
                case .crosshair:
                    radius = 4
                case .secondCursor:
                    radius = 3.4
                case .ghostArrow:
                    radius = 3.8
                }
            case .approximate:
                radius = 4.8
            case .inferred:
                radius = 4.2
            }
            context.setFillColor(withAlpha(accent.fill, alpha: 0.08 + (alpha * 0.20)))
            context.fillEllipse(
                in: CGRect(
                    x: mark.point.x - radius,
                    y: mark.point.y - radius,
                    width: radius * 2,
                    height: radius * 2
                )
            )
        }

        context.restoreGState()
    }

    private static func drawApproximateAnchor(
        in context: CGContext,
        point: CGPoint,
        accent: Accent,
        pulse: CGFloat
    ) {
        drawPulseRing(
            in: context,
            point: point,
            accent: accent,
            pulse: pulse,
            baseRadius: 15,
            spread: 16
        )

        let outerRadius: CGFloat = 14 + (pulse * 4)
        let innerRadius: CGFloat = 3.8

        context.saveGState()
        context.setAllowsAntialiasing(true)
        context.setFillColor(withAlpha(accent.soft, alpha: 0.18 + (pulse * 0.08)))
        context.fillEllipse(
            in: CGRect(
                x: point.x - outerRadius,
                y: point.y - outerRadius,
                width: outerRadius * 2,
                height: outerRadius * 2
            )
        )

        context.setStrokeColor(withAlpha(accent.stroke, alpha: 0.26 + (pulse * 0.16)))
        context.setLineWidth(1.6)
        context.strokeEllipse(
            in: CGRect(
                x: point.x - (outerRadius - 2),
                y: point.y - (outerRadius - 2),
                width: (outerRadius - 2) * 2,
                height: (outerRadius - 2) * 2
            )
        )

        context.setFillColor(accent.fill)
        context.fillEllipse(
            in: CGRect(
                x: point.x - innerRadius,
                y: point.y - innerRadius,
                width: innerRadius * 2,
                height: innerRadius * 2
            )
        )
        context.restoreGState()
    }

    private static func drawApproximatePointer(
        in context: CGContext,
        point: CGPoint,
        accent: Accent,
        pulse: CGFloat,
        tilt: CGFloat,
        style: VirtualCursorStyle
    ) {
        drawPulseRing(
            in: context,
            point: point,
            accent: accent,
            pulse: pulse,
            baseRadius: 16,
            spread: 18
        )

        context.saveGState()
        context.setAllowsAntialiasing(true)
        context.setFillColor(withAlpha(accent.soft, alpha: 0.18 + (pulse * 0.10)))
        context.fillEllipse(
            in: CGRect(x: point.x - 15, y: point.y - 15, width: 30, height: 30)
        )
        context.restoreGState()

        switch style {
        case .ghostArrow:
            drawGhostArrowApproximate(
                in: context,
                point: point,
                accent: accent,
                tilt: tilt
            )
        case .secondCursor:
            drawSecondCursorApproximate(
                in: context,
                point: point,
                accent: accent,
                tilt: tilt
            )
        case .crosshair:
            drawApproximateAnchor(
                in: context,
                point: point,
                accent: accent,
                pulse: pulse
            )
        }
    }

    private static func drawCrosshair(
        in context: CGContext,
        mark: VirtualCursorDrawMark,
        accent: Accent,
        pulse: CGFloat
    ) {
        let outerRadius: CGFloat = 13 + (pulse * 6)
        let innerRadius: CGFloat = 4.5
        let lineLength: CGFloat = 18 + (pulse * 6)

        context.saveGState()
        context.setAllowsAntialiasing(true)
        context.setFillColor(withAlpha(accent.halo, alpha: 0.15 + (pulse * 0.10)))
        context.fillEllipse(
            in: CGRect(
                x: mark.point.x - outerRadius,
                y: mark.point.y - outerRadius,
                width: outerRadius * 2,
                height: outerRadius * 2
            )
        )

        context.setStrokeColor(withAlpha(accent.stroke, alpha: 0.92))
        context.setLineWidth(2)
        context.strokeEllipse(
            in: CGRect(
                x: mark.point.x - outerRadius,
                y: mark.point.y - outerRadius,
                width: outerRadius * 2,
                height: outerRadius * 2
            )
        )

        context.beginPath()
        context.move(to: CGPoint(x: mark.point.x - lineLength, y: mark.point.y))
        context.addLine(to: CGPoint(x: mark.point.x + lineLength, y: mark.point.y))
        context.move(to: CGPoint(x: mark.point.x, y: mark.point.y - lineLength))
        context.addLine(to: CGPoint(x: mark.point.x, y: mark.point.y + lineLength))
        context.strokePath()

        context.setFillColor(accent.fill)
        context.fillEllipse(
            in: CGRect(
                x: mark.point.x - innerRadius,
                y: mark.point.y - innerRadius,
                width: innerRadius * 2,
                height: innerRadius * 2
            )
        )
        context.restoreGState()
    }

    private static func drawSecondCursor(
        in context: CGContext,
        point: CGPoint,
        accent: Accent,
        pulse: CGFloat,
        tilt: CGFloat,
        pressed: Bool
    ) {
        drawPulseRing(
            in: context,
            point: point,
            accent: accent,
            pulse: pulse,
            baseRadius: 14,
            spread: 15
        )

        let scale = 1.0 - ((pressed ? 0.16 : 0.05) * pulse)

        context.saveGState()
        context.translateBy(x: point.x, y: point.y)
        context.rotate(by: tilt)
        context.scaleBy(x: scale, y: scale)

        context.saveGState()
        context.setShadow(
            offset: .zero,
            blur: 10,
            color: CGColor(gray: 0, alpha: pressed ? 0.42 : 0.30)
        )
        let glowPath = secondCursorPath()
        context.addPath(glowPath)
        context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.72))
        context.setLineWidth(4.5)
        context.setLineJoin(.round)
        context.setLineCap(.round)
        context.strokePath()
        context.restoreGState()

        let bodyPath = secondCursorPath()
        context.addPath(bodyPath)
        context.setFillColor(
            CGColor(
                red: 0.10,
                green: 0.11,
                blue: 0.13,
                alpha: pressed ? 0.78 : 0.62
            )
        )
        context.fillPath()

        context.addPath(bodyPath)
        context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: pressed ? 0.96 : 0.88))
        context.setLineWidth(2.05)
        context.setLineJoin(.round)
        context.setLineCap(.round)
        context.strokePath()
        context.restoreGState()
    }

    private static func drawGhostArrow(
        in context: CGContext,
        point: CGPoint,
        accent: Accent,
        pulse: CGFloat,
        tilt: CGFloat
    ) {
        let scale: CGFloat = 0.90

        drawPulseRing(
            in: context,
            point: point,
            accent: accent,
            pulse: pulse,
            baseRadius: 15,
            spread: 18
        )

        context.saveGState()
        context.translateBy(x: point.x, y: point.y)
        context.rotate(by: tilt * 0.7)
        context.scaleBy(x: scale, y: scale)

        context.saveGState()
        context.setShadow(
            offset: .zero,
            blur: 16,
            color: withAlpha(accent.halo, alpha: 0.42)
        )
        let arrowPath = ghostArrowPath()
        context.addPath(arrowPath)
        context.setFillColor(CGColor(red: 0.39, green: 0.48, blue: 0.60, alpha: 0.96))
        context.fillPath()
        context.restoreGState()

        let outlinePath = ghostArrowPath()
        context.addPath(outlinePath)
        context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.96))
        context.setLineWidth(3.2)
        context.setLineJoin(.round)
        context.setLineCap(.round)
        context.strokePath()
        context.restoreGState()
    }

    private static func drawGhostArrowApproximate(
        in context: CGContext,
        point: CGPoint,
        accent: Accent,
        tilt: CGFloat
    ) {
        let scale: CGFloat = 0.90

        context.saveGState()
        context.translateBy(x: point.x, y: point.y)
        context.rotate(by: tilt * 0.65)
        context.scaleBy(x: scale, y: scale)

        context.saveGState()
        context.setShadow(
            offset: .zero,
            blur: 14,
            color: withAlpha(accent.halo, alpha: 0.34)
        )
        let arrowPath = ghostArrowPath()
        context.addPath(arrowPath)
        context.setFillColor(CGColor(red: 0.43, green: 0.54, blue: 0.67, alpha: 0.62))
        context.fillPath()
        context.restoreGState()

        let outlinePath = ghostArrowPath()
        context.addPath(outlinePath)
        context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.76))
        context.setLineWidth(2.6)
        context.setLineJoin(.round)
        context.setLineCap(.round)
        context.strokePath()
        context.restoreGState()
    }

    private static func drawSecondCursorApproximate(
        in context: CGContext,
        point: CGPoint,
        accent: Accent,
        tilt: CGFloat
    ) {
        context.saveGState()
        context.translateBy(x: point.x, y: point.y)
        context.rotate(by: tilt)

        context.saveGState()
        context.setShadow(
            offset: .zero,
            blur: 10,
            color: withAlpha(accent.halo, alpha: 0.28)
        )
        let glowPath = secondCursorPath()
        context.addPath(glowPath)
        context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.54))
        context.setLineWidth(4.0)
        context.setLineJoin(.round)
        context.setLineCap(.round)
        context.strokePath()
        context.restoreGState()

        let bodyPath = secondCursorPath()
        context.addPath(bodyPath)
        context.setFillColor(CGColor(red: 0.10, green: 0.11, blue: 0.13, alpha: 0.42))
        context.fillPath()

        context.addPath(bodyPath)
        context.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 0.72))
        context.setLineWidth(1.8)
        context.setLineJoin(.round)
        context.setLineCap(.round)
        context.strokePath()
        context.restoreGState()
    }

    private static func drawKeyboardBadge(
        in context: CGContext,
        point: CGPoint,
        accent: Accent,
        pulse: CGFloat
    ) {
        drawPulseRing(
            in: context,
            point: point,
            accent: accent,
            pulse: pulse,
            baseRadius: 17,
            spread: 18
        )

        let badgeRect = CGRect(x: point.x - 18, y: point.y - 12, width: 36, height: 24)
        let badgePath = CGPath(
            roundedRect: badgeRect,
            cornerWidth: 7,
            cornerHeight: 7,
            transform: nil
        )

        context.saveGState()
        context.setAllowsAntialiasing(true)
        context.addPath(badgePath)
        context.setFillColor(CGColor(red: 0.08, green: 0.10, blue: 0.14, alpha: 0.82))
        context.fillPath()

        context.addPath(badgePath)
        context.setStrokeColor(withAlpha(accent.stroke, alpha: 0.88))
        context.setLineWidth(2)
        context.strokePath()

        let keyWidth: CGFloat = 6
        let keyHeight: CGFloat = 4
        let keyY = badgeRect.minY + 6
        for x in stride(from: badgeRect.minX + 6, through: badgeRect.maxX - 12, by: 9) {
            context.setFillColor(withAlpha(accent.fill, alpha: 0.84))
            context.fill(
                CGRect(
                    x: x,
                    y: keyY,
                    width: keyWidth,
                    height: keyHeight
                )
            )
        }

        context.setFillColor(withAlpha(accent.fill, alpha: 0.68))
        context.fill(
            CGRect(
                x: badgeRect.minX + 8,
                y: badgeRect.minY + 14,
                width: badgeRect.width - 16,
                height: 4
            )
        )
        context.restoreGState()
    }

    private static func drawPulseRing(
        in context: CGContext,
        point: CGPoint,
        accent: Accent,
        pulse: CGFloat,
        baseRadius: CGFloat,
        spread: CGFloat
    ) {
        guard pulse > 0.01 else {
            return
        }

        let expansion = 1 - pulse
        let radius = baseRadius + (spread * expansion)
        context.saveGState()
        context.setFillColor(withAlpha(accent.soft, alpha: 0.08 + (pulse * 0.10)))
        context.fillEllipse(
            in: CGRect(
                x: point.x - radius,
                y: point.y - radius,
                width: radius * 2,
                height: radius * 2
            )
        )

        context.setStrokeColor(withAlpha(accent.stroke, alpha: 0.14 + (pulse * 0.34)))
        context.setLineWidth(1.8)
        context.strokeEllipse(
            in: CGRect(
                x: point.x - radius,
                y: point.y - radius,
                width: radius * 2,
                height: radius * 2
            )
        )
        context.restoreGState()
    }

    private static func secondCursorPath() -> CGPath {
        let path = CGMutablePath()
        path.move(to: CGPoint(x: 0, y: 0))
        path.addLine(to: CGPoint(x: 18, y: 10))
        path.addQuadCurve(
            to: CGPoint(x: 12, y: 13),
            control: CGPoint(x: 19, y: 12)
        )
        path.addLine(to: CGPoint(x: 16.5, y: 28))
        path.addQuadCurve(
            to: CGPoint(x: 12.5, y: 30.5),
            control: CGPoint(x: 15.6, y: 31.2)
        )
        path.addLine(to: CGPoint(x: 7.8, y: 17.2))
        path.addQuadCurve(
            to: CGPoint(x: 5.8, y: 15.8),
            control: CGPoint(x: 6.9, y: 16.4)
        )
        path.addLine(to: CGPoint(x: 0.3, y: 3.6))
        path.addQuadCurve(
            to: CGPoint(x: 0, y: 0),
            control: CGPoint(x: -0.8, y: 1.8)
        )
        path.closeSubpath()
        return path
    }

    private static func ghostArrowPath() -> CGPath {
        let path = CGMutablePath()
        path.move(to: CGPoint(x: 0, y: 0))
        path.addLine(to: CGPoint(x: 24, y: 13))
        path.addQuadCurve(
            to: CGPoint(x: 22.8, y: 17.2),
            control: CGPoint(x: 27.2, y: 15.2)
        )
        path.addLine(to: CGPoint(x: 13.8, y: 19.2))
        path.addQuadCurve(
            to: CGPoint(x: 12.2, y: 20.9),
            control: CGPoint(x: 12.8, y: 19.6)
        )
        path.addLine(to: CGPoint(x: 8.6, y: 34.2))
        path.addQuadCurve(
            to: CGPoint(x: 4.4, y: 33.2),
            control: CGPoint(x: 7.6, y: 37.4)
        )
        path.addLine(to: CGPoint(x: 0.4, y: 5.6))
        path.addQuadCurve(
            to: CGPoint(x: 0, y: 0),
            control: CGPoint(x: -0.6, y: 2.2)
        )
        path.closeSubpath()
        return path
    }

    private static func pulseAmount(age: TimeInterval) -> CGFloat {
        let clamped = max(0, min(age, 0.40))
        return CGFloat(1 - (clamped / 0.40))
    }

    private static func isPressAction(_ kind: String) -> Bool {
        let normalized = kind.lowercased()
        return normalized.contains("click")
            || normalized.contains("drag")
            || normalized.contains("perform")
    }

    private static func accent(for _: String) -> Accent {
        return Accent(
            stroke: CGColor(red: 0.78, green: 0.88, blue: 0.97, alpha: 0.96),
            fill: CGColor(red: 0.43, green: 0.54, blue: 0.67, alpha: 0.92),
            halo: CGColor(red: 0.48, green: 0.67, blue: 0.90, alpha: 0.28),
            soft: CGColor(red: 0.48, green: 0.67, blue: 0.90, alpha: 0.16)
        )
    }

    private static func withAlpha(_ color: CGColor, alpha: CGFloat) -> CGColor {
        guard let adjusted = color.copy(alpha: alpha) else {
            return color
        }
        return adjusted
    }
}

public extension VirtualCursorStyle {
    var defaultShowTrail: Bool {
        switch self {
        case .crosshair:
            return true
        case .secondCursor, .ghostArrow:
            return false
        }
    }
}
