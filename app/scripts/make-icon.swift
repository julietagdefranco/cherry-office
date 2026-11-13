// Genera un PNG 1024x1024 (fondo crema redondeado + logo centrado) desde un SVG.
// Uso: swift make-icon.swift <logo.svg> <salida.png>
import AppKit

let args = CommandLine.arguments
guard args.count == 3, let svg = NSImage(contentsOf: URL(fileURLWithPath: args[1])) else {
    FileHandle.standardError.write(Data("no pude leer el SVG\n".utf8)); exit(1)
}
let size: CGFloat = 1024
guard let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size), pixelsHigh: Int(size), bitsPerSample: 8,
                                 samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                                 bytesPerRow: 0, bitsPerPixel: 0) else { exit(1) }
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
let inset: CGFloat = 100
let bg = NSBezierPath(roundedRect: NSRect(x: inset, y: inset, width: size - 2 * inset, height: size - 2 * inset), xRadius: 180, yRadius: 180)
NSColor(red: 0.992, green: 0.906, blue: 0.953, alpha: 1).setFill()
bg.fill()
let w = size - 2 * inset - 120
let ratio = svg.size.height / max(svg.size.width, 1)
let h = w * ratio
svg.draw(in: NSRect(x: (size - w) / 2, y: (size - h) / 2, width: w, height: h))
NSGraphicsContext.restoreGraphicsState()
guard let png = rep.representation(using: .png, properties: [:]) else { exit(1) }
try png.write(to: URL(fileURLWithPath: args[2]))
