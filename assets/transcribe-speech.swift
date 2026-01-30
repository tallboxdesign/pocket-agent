import Foundation
import Speech

guard CommandLine.arguments.count > 1 else {
    fputs("Usage: transcribe-speech <audio-file-path>\n", stderr)
    exit(1)
}

let audioPath = CommandLine.arguments[1]
let audioURL = URL(fileURLWithPath: audioPath)

guard FileManager.default.fileExists(atPath: audioPath) else {
    fputs("File not found: \(audioPath)\n", stderr)
    exit(1)
}

var isDone = false
var exitCode: Int32 = 0

SFSpeechRecognizer.requestAuthorization { status in
    guard status == .authorized else {
        let reason: String
        switch status {
        case .denied: reason = "denied"
        case .restricted: reason = "restricted"
        case .notDetermined: reason = "not determined"
        default: reason = "unknown"
        }
        fputs("Speech recognition authorization \(reason)\n", stderr)
        exitCode = 2
        isDone = true
        return
    }

    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: "en-US")),
          recognizer.isAvailable else {
        fputs("Speech recognizer not available\n", stderr)
        exitCode = 3
        isDone = true
        return
    }

    let request = SFSpeechURLRecognitionRequest(url: audioURL)
    request.shouldReportPartialResults = false

    recognizer.recognitionTask(with: request) { result, error in
        if let error = error {
            fputs("Recognition error: \(error.localizedDescription)\n", stderr)
            exitCode = 4
            isDone = true
            return
        }

        if let result = result, result.isFinal {
            print(result.bestTranscription.formattedString)
            isDone = true
        }
    }
}

// Run loop to wait for async completion
let timeout = Date(timeIntervalSinceNow: 30)
while !isDone && Date() < timeout {
    RunLoop.main.run(until: Date(timeIntervalSinceNow: 0.1))
}

if !isDone {
    fputs("Transcription timed out\n", stderr)
    exit(5)
}

exit(exitCode)
