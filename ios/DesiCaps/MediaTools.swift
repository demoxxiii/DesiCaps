import AVFoundation
import CoreImage
import Foundation
import Photos
import UIKit

/// Video probing, audio decoding (for Whisper), preview copies and caption burn-in export.
enum MediaTools {

    struct Probe {
        var width: Int, height: Int, duration: Double, fps: Double
    }

    static func probe(_ url: URL) async throws -> Probe {
        let asset = AVURLAsset(url: url)
        let dur = try await asset.load(.duration).seconds
        guard let track = try await asset.loadTracks(withMediaType: .video).first else {
            throw NSError(domain: "DesiCaps", code: 20, userInfo: [NSLocalizedDescriptionKey: "This file has no video track."])
        }
        let (size, t, fps) = try await track.load(.naturalSize, .preferredTransform, .nominalFrameRate)
        let r = CGRect(origin: .zero, size: size).applying(t)
        return Probe(width: Int(abs(r.width).rounded()), height: Int(abs(r.height).rounded()),
                     duration: dur.isFinite ? dur : 0, fps: fps > 0 ? Double(fps) : 30)
    }

    /// 16 kHz mono float PCM, the format Whisper expects.
    static func decodeAudio(_ url: URL, cancelled: @escaping () -> Bool, progress: @escaping (Double) -> Void) async throws -> [Float] {
        let asset = AVURLAsset(url: url)
        guard let track = try await asset.loadTracks(withMediaType: .audio).first else {
            throw NSError(domain: "DesiCaps", code: 21, userInfo: [NSLocalizedDescriptionKey: "This video has no sound track."])
        }
        let total = try await asset.load(.duration).seconds
        let reader = try AVAssetReader(asset: asset)
        let out = AVAssetReaderTrackOutput(track: track, outputSettings: [
            AVFormatIDKey: kAudioFormatLinearPCM,
            AVSampleRateKey: 16000,
            AVNumberOfChannelsKey: 1,
            AVLinearPCMBitDepthKey: 32,
            AVLinearPCMIsFloatKey: true,
            AVLinearPCMIsNonInterleaved: false,
            AVLinearPCMIsBigEndianKey: false,
        ])
        out.alwaysCopiesSampleData = false
        reader.add(out)
        guard reader.startReading() else { throw reader.error ?? NSError(domain: "DesiCaps", code: 22) }
        var samples: [Float] = []
        samples.reserveCapacity(Int(max(1, total)) * 16000)
        var lastReport = 0.0
        while let sb = out.copyNextSampleBuffer() {
            if cancelled() { reader.cancelReading(); throw CancellationError() }
            if let bb = CMSampleBufferGetDataBuffer(sb) {
                let len = CMBlockBufferGetDataLength(bb)
                var chunk = [Float](repeating: 0, count: len / 4)
                chunk.withUnsafeMutableBytes { raw in
                    _ = CMBlockBufferCopyDataBytes(bb, atOffset: 0, dataLength: len, destination: raw.baseAddress!)
                }
                samples.append(contentsOf: chunk)
            }
            if total > 0 {
                let f = min(1, Double(samples.count) / 16000 / total)
                if f - lastReport > 0.05 { lastReport = f; progress(f) }
            }
        }
        if reader.status == .failed { throw reader.error ?? NSError(domain: "DesiCaps", code: 23) }
        return samples
    }

    /// Light 720p copy for the editor preview (rarely needed on iPhone; kept for parity with Android).
    static func makePreview(_ input: URL, to output: URL) async throws {
        try? FileManager.default.removeItem(at: output)
        let asset = AVURLAsset(url: input)
        guard let s = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset1280x720) else {
            throw NSError(domain: "DesiCaps", code: 24)
        }
        s.outputURL = output
        s.outputFileType = .mp4
        s.shouldOptimizeForNetworkUse = true
        await s.export()
        if s.status != .completed { throw s.error ?? NSError(domain: "DesiCaps", code: 25) }
    }

    // MARK: - export with captions

    struct Frame { let url: URL; let x: CGFloat; let y: CGFloat }

    /// Picks the caption image for each video frame and composites it with Core Image.
    final class Overlay {
        let times: [Double]   // seconds, ascending
        let ids: [Int]        // -1 = no caption
        let frames: [Int: Frame]
        let planW: CGFloat, planH: CGFloat
        let masks: [Int]?    // "negative text" mask frame per entry, -1 = none
        private let lock = NSLock()
        private var cache: [Int: CIImage] = [:]
        private var cacheOrder: [Int] = []

        init(times: [Double], ids: [Int], frames: [Int: Frame], planW: CGFloat, planH: CGFloat, masks: [Int]? = nil) {
            self.times = times; self.ids = ids; self.frames = frames; self.planW = planW; self.planH = planH
            self.masks = masks
        }

        private func index(at t: Double) -> Int {
            var lo = 0, hi = times.count - 1, idx = -1
            while lo <= hi {
                let mid = (lo + hi) / 2
                if times[mid] <= t + 0.0005 { idx = mid; lo = mid + 1 } else { hi = mid - 1 }
            }
            return idx
        }

        func id(at t: Double) -> Int {
            let idx = index(at: t)
            return idx < 0 ? -1 : ids[idx]
        }

        func image(for id: Int) -> (CIImage, Frame)? {
            guard id >= 0, let f = frames[id] else { return nil }
            lock.lock(); defer { lock.unlock() }
            if let img = cache[id] { return (img, f) }
            guard let img = CIImage(contentsOf: f.url) else { return nil }
            cache[id] = img; cacheOrder.append(id)
            if cacheOrder.count > 4 { cache.removeValue(forKey: cacheOrder.removeFirst()) }
            return (img, f)
        }

        /// Scales a plan-space band image into the video's extent.
        private func place(_ img: CIImage, _ f: Frame, in ext: CGRect) -> CIImage {
            let s = ext.width / planW
            let h = img.extent.height
            // plan coordinates are top-left based; Core Image is bottom-left based
            let tx = ext.minX + f.x * s
            let ty = ext.minY + (planH - f.y - h) * s
            return img.transformed(by: CGAffineTransform(scaleX: s, y: s))
                .transformed(by: CGAffineTransform(translationX: tx, y: ty))
        }

        func apply(_ source: CIImage, time: Double) -> CIImage {
            let idx = index(at: time)
            guard idx >= 0 else { return source }
            let ext = source.extent
            var base = source
            if let masks = masks, masks[idx] >= 0, let m = image(for: masks[idx]) {
                // negative text: invert the video wherever the mask's alpha is set
                let mask = place(m.0, m.1, in: ext).cropped(to: ext)
                let inverted = source.applyingFilter("CIColorInvert")
                let alphaMask = mask.applyingFilter("CIColorMatrix", parameters: [
                    "inputRVector": CIVector(x: 0, y: 0, z: 0, w: 1),
                    "inputGVector": CIVector(x: 0, y: 0, z: 0, w: 1),
                    "inputBVector": CIVector(x: 0, y: 0, z: 0, w: 1),
                    "inputAVector": CIVector(x: 0, y: 0, z: 0, w: 0),
                    "inputBiasVector": CIVector(x: 0, y: 0, z: 0, w: 1),
                ])
                base = inverted.applyingFilter("CIBlendWithMask", parameters: [
                    kCIInputBackgroundImageKey: source,
                    kCIInputMaskImageKey: alphaMask,
                ]).cropped(to: ext)
            }
            guard ids[idx] >= 0, let hit = image(for: ids[idx]) else { return base }
            return place(hit.0, hit.1, in: ext).composited(over: base)
        }
    }

    static var currentExport: AVAssetExportSession?

    static func export(input: URL, overlay: Overlay, output: URL,
                       progress: @escaping (Double) -> Void) async throws {
        // (progress is polled on the main run loop while the export session runs)
        try? FileManager.default.removeItem(at: output)
        let asset = AVURLAsset(url: input)
        let composition = try await AVVideoComposition.videoComposition(with: asset) { request in
            let out = overlay.apply(request.sourceImage, time: request.compositionTime.seconds)
            request.finish(with: out, context: nil)
        }
        guard let s = AVAssetExportSession(asset: asset, presetName: AVAssetExportPreset1920x1080) else {
            throw NSError(domain: "DesiCaps", code: 26, userInfo: [NSLocalizedDescriptionKey: "Export isn't available on this device."])
        }
        s.outputURL = output
        s.outputFileType = .mp4
        s.videoComposition = composition
        s.shouldOptimizeForNetworkUse = true
        currentExport = s
        defer { currentExport = nil }
        let timer = Timer(timeInterval: 0.4, repeats: true) { _ in progress(Double(s.progress)) }
        RunLoop.main.add(timer, forMode: .common)
        await s.export()
        timer.invalidate()
        if s.status == .cancelled { throw CancellationError() }
        if s.status != .completed { throw s.error ?? NSError(domain: "DesiCaps", code: 27) }
    }

    static func saveToPhotos(_ url: URL) async throws {
        let status = await PHPhotoLibrary.requestAuthorization(for: .addOnly)
        guard status == .authorized || status == .limited else {
            throw NSError(domain: "DesiCaps", code: 28, userInfo: [NSLocalizedDescriptionKey:
                "DesiCaps can't save to Photos. Allow it in Settings → DesiCaps → Photos. The video is still in the Files app (On My iPhone → DesiCaps)."])
        }
        try await PHPhotoLibrary.shared().performChanges {
            PHAssetChangeRequest.creationRequestForAssetFromVideo(atFileURL: url)
        }
    }
}
