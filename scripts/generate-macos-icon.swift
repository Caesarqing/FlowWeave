import AppKit
import Foundation

guard CommandLine.arguments.count == 3 else {
  fputs("Usage: swift generate-macos-icon.swift <source.png> <output.png>\n", stderr)
  exit(1)
}

let sourceURL = URL(fileURLWithPath: CommandLine.arguments[1])
let outputURL = URL(fileURLWithPath: CommandLine.arguments[2])
guard let source = NSImage(contentsOf: sourceURL) else {
  fputs("Unable to read source icon: \(sourceURL.path)\n", stderr)
  exit(1)
}

let canvasSize = NSSize(width: 1024, height: 1024)
let image = NSImage(size: canvasSize)
image.lockFocus()

NSColor.clear.setFill()
NSRect(origin: .zero, size: canvasSize).fill()

let iconRect = NSRect(x: 64, y: 64, width: 896, height: 896)
let iconPath = NSBezierPath(roundedRect: iconRect, xRadius: 196, yRadius: 196)
iconPath.addClip()
NSColor.black.setFill()
iconRect.fill()
source.draw(
  in: iconRect,
  from: NSRect(origin: .zero, size: source.size),
  operation: .sourceOver,
  fraction: 1
)

image.unlockFocus()

guard
  let tiff = image.tiffRepresentation,
  let bitmap = NSBitmapImageRep(data: tiff),
  let png = bitmap.representation(using: .png, properties: [:])
else {
  fputs("Unable to encode generated application icon.\n", stderr)
  exit(1)
}

try png.write(to: outputURL, options: .atomic)
