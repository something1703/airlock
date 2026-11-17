import SwiftUI

/// The Airlock mark: two nested arcs (the doors) over a sill, on a 64-pt grid (web `Logo`).
/// `animated` draws the arcs on and lets the inner door breathe; Reduce Motion shows it still.
struct AirlockLogo: View {
    var size: CGFloat = 28
    var animated = false

    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var outer: CGFloat = 1
    @State private var inner: CGFloat = 1
    @State private var sill: CGFloat = 1
    @State private var breathe = false

    private static let outerArc = SVGPath.parse("M12 42a20 20 0 0 1 40 0")
    private static let innerArc = SVGPath.parse("M21 42a11 11 0 0 1 22 0")
    private static let sillLine = SVGPath.parse("M10 50h44")

    var body: some View {
        let k = size / 64
        ZStack {
            LogoPart(path: Self.outerArc).trim(from: 0, to: outer)
                .stroke(Palette.seal, style: StrokeStyle(lineWidth: 5 * k, lineCap: .round))
            LogoPart(path: Self.innerArc).trim(from: 0, to: inner)
                .stroke(Palette.seal, style: StrokeStyle(lineWidth: 5 * k, lineCap: .round))
                .opacity(breathe ? 0.45 : 1)
            LogoPart(path: Self.sillLine).trim(from: 0, to: sill)
                .stroke(Palette.text2.opacity(0.6), style: StrokeStyle(lineWidth: 3 * k, lineCap: .round))
        }
        .frame(width: size, height: size)
        .accessibilityHidden(true)
        .onAppear(perform: start)
    }

    private func start() {
        guard animated, !reduceMotion else { return }
        outer = 0
        inner = 0
        sill = 0
        withAnimation(Motion.easeOut(0.9)) { outer = 1 }
        withAnimation(Motion.easeOut(0.9).delay(0.18)) { inner = 1 }
        withAnimation(Motion.easeOut(0.9).delay(0.3)) { sill = 1 }
        withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true).delay(1.2)) { breathe = true }
    }
}

/// A logo stroke in the 64-pt grid, scaled to the frame.
private struct LogoPart: Shape {
    let path: Path
    func path(in rect: CGRect) -> Path {
        path.applying(CGAffineTransform(translationX: rect.minX, y: rect.minY).scaledBy(x: rect.width / 64, y: rect.height / 64))
    }
}

#Preview("Logo") {
    HStack(spacing: 24) {
        AirlockLogo(size: 28)
        AirlockLogo(size: 64, animated: true)
        AirlockLogo(size: 120, animated: true)
    }
    .padding(40)
    .background(Palette.bg)
}
