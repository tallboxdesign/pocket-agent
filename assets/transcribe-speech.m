#import <Foundation/Foundation.h>
#import <Speech/Speech.h>

int main(int argc, const char * argv[]) {
    @autoreleasepool {
        if (argc < 2) {
            fprintf(stderr, "Usage: transcribe-speech <audio-file-path>\n");
            return 1;
        }

        NSString *audioPath = [NSString stringWithUTF8String:argv[1]];
        NSURL *audioURL = [NSURL fileURLWithPath:audioPath];

        if (![[NSFileManager defaultManager] fileExistsAtPath:audioPath]) {
            fprintf(stderr, "File not found: %s\n", argv[1]);
            return 1;
        }

        __block BOOL isDone = NO;
        __block int exitCode = 0;

        [SFSpeechRecognizer requestAuthorization:^(SFSpeechRecognizerAuthorizationStatus status) {
            if (status != SFSpeechRecognizerAuthorizationStatusAuthorized) {
                fprintf(stderr, "Speech recognition not authorized (status: %ld)\n", (long)status);
                exitCode = 2;
                isDone = YES;
                return;
            }

            NSLocale *locale = [NSLocale localeWithLocaleIdentifier:@"en-US"];
            SFSpeechRecognizer *recognizer = [[SFSpeechRecognizer alloc] initWithLocale:locale];

            if (!recognizer || !recognizer.isAvailable) {
                fprintf(stderr, "Speech recognizer not available\n");
                exitCode = 3;
                isDone = YES;
                return;
            }

            SFSpeechURLRecognitionRequest *request = [[SFSpeechURLRecognitionRequest alloc] initWithURL:audioURL];
            request.shouldReportPartialResults = NO;

            [recognizer recognitionTaskWithRequest:request resultHandler:^(SFSpeechRecognitionResult * _Nullable result, NSError * _Nullable error) {
                if (error) {
                    fprintf(stderr, "Recognition error: %s\n", [[error localizedDescription] UTF8String]);
                    exitCode = 4;
                    isDone = YES;
                    return;
                }

                if (result && result.isFinal) {
                    NSString *text = result.bestTranscription.formattedString;
                    printf("%s", [text UTF8String]);
                    isDone = YES;
                }
            }];
        }];

        // Run loop to wait for async completion (90s timeout per chunk)
        NSDate *timeout = [NSDate dateWithTimeIntervalSinceNow:90.0];
        while (!isDone && [[NSDate date] compare:timeout] == NSOrderedAscending) {
            [[NSRunLoop mainRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
        }

        if (!isDone) {
            fprintf(stderr, "Transcription timed out\n");
            return 5;
        }

        return exitCode;
    }
}
