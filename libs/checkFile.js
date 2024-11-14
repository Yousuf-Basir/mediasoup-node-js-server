import fs from 'fs';
import path from 'path';

export function checkRecordingFiles(directoryPath = './recordings') {
    return new Promise((resolve, reject) => {
        try {
            // Check if directory exists
            if (!fs.existsSync(directoryPath)) {
                throw new Error(`Directory ${directoryPath} does not exist`);
            }

            // Read directory contents
            const files = fs.readdirSync(directoryPath);
            
            // Find audio and video files
            const audioFile = files.find(file => file.toLowerCase().startsWith('audio'));
            const videoFile = files.find(file => file.toLowerCase().startsWith('video'));

            // Prepare detailed response
            const result = {
                isReady: Boolean(audioFile && videoFile),
                files: {
                    audio: audioFile || null,
                    video: videoFile || null
                },
                details: {
                    audioFound: Boolean(audioFile),
                    videoFound: Boolean(videoFile),
                    audioPath: audioFile ? path.join(directoryPath, audioFile) : null,
                    videoPath: videoFile ? path.join(directoryPath, videoFile) : null
                }
            };

            resolve(result);
        } catch (error) {
            reject(error);
        }
    });
}