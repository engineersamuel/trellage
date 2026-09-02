import CoreGraphics
import Foundation

public enum PanelPlacement {
    public static func appKitPoint(fromQuartz point: CGPoint, mainDisplayHeight: CGFloat) -> CGPoint {
        CGPoint(x: point.x, y: mainDisplayHeight - point.y)
    }

    public static func appKitRect(fromQuartz rect: CGRect, mainDisplayHeight: CGFloat) -> CGRect {
        let first = appKitPoint(
            fromQuartz: CGPoint(x: rect.minX, y: rect.minY),
            mainDisplayHeight: mainDisplayHeight
        )
        let second = appKitPoint(
            fromQuartz: CGPoint(x: rect.maxX, y: rect.maxY),
            mainDisplayHeight: mainDisplayHeight
        )
        return CGRect(
            x: min(first.x, second.x),
            y: min(first.y, second.y),
            width: abs(first.x - second.x),
            height: abs(first.y - second.y)
        )
    }

    public static func frame(
        selection: CGRect,
        panelSize: CGSize,
        visibleFrames: [CGRect],
        gap: CGFloat = 8
    ) -> CGRect? {
        guard panelSize.width > 0, panelSize.height > 0,
              let display = bestDisplay(for: selection, visibleFrames: visibleFrames)
        else {
            return nil
        }

        var x = selection.midX - panelSize.width / 2
        let above = selection.maxY + gap
        let below = selection.minY - gap - panelSize.height
        var y: CGFloat

        if above + panelSize.height <= display.maxY {
            y = above
        } else if below >= display.minY {
            y = below
        } else {
            y = min(max(above, display.minY), display.maxY - panelSize.height)
        }

        x = min(max(x, display.minX), display.maxX - panelSize.width)
        y = min(max(y, display.minY), display.maxY - panelSize.height)
        return CGRect(origin: CGPoint(x: x, y: y), size: panelSize)
    }

    private static func bestDisplay(for selection: CGRect, visibleFrames: [CGRect]) -> CGRect? {
        if let containing = visibleFrames.first(where: { $0.contains(selection.center) }) {
            return containing
        }
        return visibleFrames.max {
            $0.intersection(selection).area < $1.intersection(selection).area
        }
    }
}

private extension CGRect {
    var center: CGPoint { CGPoint(x: midX, y: midY) }
    var area: CGFloat { isNull ? 0 : width * height }
}
