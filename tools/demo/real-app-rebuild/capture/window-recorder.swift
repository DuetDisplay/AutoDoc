import Foundation
import AppKit
import ScreenCaptureKit
import AVFoundation
import CoreMedia

@MainActor final class WindowRecorder: NSObject, @preconcurrency SCStreamOutput, @preconcurrency SCStreamDelegate {
 var writer: AVAssetWriter!
 var input: AVAssetWriterInput!
 var stream: SCStream!
 var started = false
 let queue = DispatchQueue.main
 func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
  self.append(sampleBuffer, type: type)
 }
 private func append(_ sampleBuffer: CMSampleBuffer, type: SCStreamOutputType) {
  guard type == .screen, sampleBuffer.isValid else { return }
  if let a = CMSampleBufferGetSampleAttachmentsArray(sampleBuffer, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]], let status = a.first?[.status] as? Int, status != SCFrameStatus.complete.rawValue { return }
  if !started { writer.startWriting(); writer.startSession(atSourceTime: sampleBuffer.presentationTimeStamp); started = true }
  if input.isReadyForMoreMediaData { if !input.append(sampleBuffer) { print("append: \(writer.error?.localizedDescription ?? "unknown")") } }
 }
 func stream(_ stream: SCStream, didStopWithError error: Error) { print("stream error: \(error)") }
 func run(window: SCWindow, output: URL, seconds: Double) async throws {
  let w = Int(window.frame.width) * 2 / 2 * 2, h = Int(window.frame.height) * 2 / 2 * 2
  let config = SCStreamConfiguration(); config.width = w; config.height = h
  config.minimumFrameInterval = CMTime(value:1,timescale:60); config.queueDepth = 6; config.showsCursor = false
  config.capturesAudio = false; config.pixelFormat = kCVPixelFormatType_32BGRA
  writer = try AVAssetWriter(outputURL:output,fileType:.mov)
  input = AVAssetWriterInput(mediaType:.video,outputSettings:[AVVideoCodecKey:AVVideoCodecType.h264,AVVideoWidthKey:w,AVVideoHeightKey:h,AVVideoCompressionPropertiesKey:[AVVideoAverageBitRateKey:24000000,AVVideoProfileLevelKey:AVVideoProfileLevelH264HighAutoLevel]])
  input.expectsMediaDataInRealTime = true; writer.add(input)
  stream = SCStream(filter:SCContentFilter(desktopIndependentWindow:window),configuration:config,delegate:self)
  try stream.addStreamOutput(self,type:.screen,sampleHandlerQueue:queue)
  try await stream.startCapture(); print("CAPTURE_STARTED \(w)x\(h) window=\(window.windowID)")
  try await Task.sleep(nanoseconds:UInt64(seconds*1_000_000_000))
  try await stream.stopCapture()
  input.markAsFinished()
  await writer.finishWriting()
  if writer.status != .completed { throw writer.error ?? NSError(domain:"capture",code:1) }
  print("CAPTURE_DONE \(output.path)")
 }
}
let captureApplication = NSApplication.shared
captureApplication.setActivationPolicy(.prohibited)
Task {
 do {
  let content = try await SCShareableContent.excludingDesktopWindows(false,onScreenWindowsOnly:false)
  let args = CommandLine.arguments
  if args.count < 4 {
   for w in content.windows where (w.owningApplication?.applicationName.contains("Electron") ?? false) || (w.owningApplication?.applicationName.contains("AutoDoc") ?? false) || (w.owningApplication?.applicationName.contains("Firefox") ?? false) {
    print("WINDOW \(w.windowID) app=\(w.owningApplication?.applicationName ?? "") title=\(w.title ?? "") frame=\(w.frame)")
   }
   exit(0)
  }
  guard let id = UInt32(args[1]),let window = content.windows.first(where:{$0.windowID == id}) else { throw NSError(domain:"window",code:1) }
  try await WindowRecorder().run(window:window,output:URL(fileURLWithPath:args[2]),seconds:Double(args[3])!)
  exit(0)
 }catch{ print("CAPTURE_FAILED \(error)");exit(1) }
}
captureApplication.run()
