import { spawn } from 'child_process';
import { checkRecordingFiles } from './checkFile.js';
const ffmpegCommand = 'ffmpeg';

export const runFFMPEGScript = async () => {
    const result = await checkRecordingFiles();
    if (!result.isReady) {
        return;
    }
    const ffmpegArgs = [
        '-protocol_whitelist', 'file,rtp,udp',
        '-re',
        '-i', './recordings/video.sdp',
        '-protocol_whitelist', 'file,rtp,udp',
        '-re',
        '-i', './recordings/audio.sdp',
        '-c:v', 'libx264',
        '-c:a', 'aac',
        '-ar', '44100',
        '-ac', '1',
        '-f', 'flv',
        'rtmp://localhost/live/stream'
    ];
    
    const ffmpegProcess = spawn(ffmpegCommand, ffmpegArgs);
    
    ffmpegProcess.stdout.on('data', (data) => {
        console.log(`stdout: ${data}`);
    });
    
    ffmpegProcess.stderr.on('data', (data) => {
        console.log(`stderr: ${data}`);
    });
    
    ffmpegProcess.on('close', (code) => {
        console.log(`Child process exited with code ${code}`);
    });
    
    ffmpegProcess.on('error', (error) => {
        console.error(`Error: ${error.message}`);
    });
}