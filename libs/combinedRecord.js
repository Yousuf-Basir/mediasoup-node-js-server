import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import FFmpegStatic from 'ffmpeg-static';
import * as fsPromise from 'fs/promises'

const __dirname = path.resolve();
function sleep(ms) {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

// Add these to your global state
let recordings = new Map(); // Map to store active recordings
const recordingsPath = path.join(__dirname, 'recordings');

// Create recordings directory if it doesn't exist
if (!fs.existsSync(recordingsPath)) {
    fs.mkdirSync(recordingsPath, { recursive: true });
}

const generateCombinedSdp = (audioConsumer, videoConsumer) => {
    const audioCodec = audioConsumer.rtpParameters.codecs[0];
    const videoCodec = videoConsumer.rtpParameters.codecs[0];
    const audioSsrc = audioConsumer.rtpParameters.encodings[0].ssrc;
    const videoSsrc = videoConsumer.rtpParameters.encodings[0].ssrc;

    const sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=FFmpeg
c=IN IP4 127.0.0.1
t=0 0
m=audio 20000 RTP/AVPF ${audioCodec.payloadType}
a=rtcp:20000
a=rtpmap:${audioCodec.payloadType} ${audioCodec.mimeType.split('/')[1]}/${audioCodec.clockRate}/${audioCodec.channels}
a=recvonly
a=rtcp-mux
a=ssrc:${audioSsrc} cname:FFmpeg
a=ssrc:${audioSsrc} msid:FFmpeg FFmpeg
a=ssrc:${audioSsrc} mslabel:FFmpeg
a=ssrc:${audioSsrc} label:FFmpeg
m=video 20002 RTP/AVPF ${videoCodec.payloadType}
a=rtcp:20002
a=rtpmap:${videoCodec.payloadType} ${videoCodec.mimeType.split('/')[1]}/${videoCodec.clockRate}
a=recvonly
a=rtcp-mux
a=ssrc:${videoSsrc} cname:FFmpeg
a=ssrc:${videoSsrc} msid:FFmpeg FFmpeg
a=ssrc:${videoSsrc} mslabel:FFmpeg
a=ssrc:${videoSsrc} label:FFmpeg
a=fmtp:${videoCodec.payloadType} x-google-min-bitrate=1000;x-google-max-bitrate=3000;x-google-start-bitrate=2000`;

    return sdp.split('\n').map(line => line.trim()).join('\n');
};

const createPlainRtpTransport = async (router) => {
    return await router.createPlainTransport({
        listenIp: { ip: '127.0.0.1', announcedIp: null },
        rtcpMux: true,
        comedia: false
    });
};

export const startCombinedRecording = async (audioProducer, videoProducer, roomName, peerId, rooms) => {
    const router = rooms[roomName].router;

    try {
        // Create transports for both audio and video
        const audioTransport = await createPlainRtpTransport(router);
        const videoTransport = await createPlainRtpTransport(router);

        // Create consumers for both audio and video
        const audioConsumer = await audioTransport.consume({
            producerId: audioProducer.id,
            rtpCapabilities: router.rtpCapabilities,
            paused: false
        });

        const videoConsumer = await videoTransport.consume({
            producerId: videoProducer.id,
            rtpCapabilities: router.rtpCapabilities,
            paused: false
        });

        const timestamp = new Date().getTime();
        const fileName = `${roomName}_${peerId}_combined_${timestamp}.mkv`;
        const filePath = path.join(recordingsPath, fileName);

        // Generate combined SDP file
        const sdpContent = generateCombinedSdp(audioConsumer, videoConsumer);
        const sdpPath = path.join(recordingsPath, `${timestamp}_combined.sdp`);

        fs.writeFileSync(sdpPath, sdpContent.replace(/\r\n/g, '\n'));

        // FFmpeg arguments for combined recording
        const ffmpegArgs = [
            '-loglevel', 'debug',
            '-protocol_whitelist', 'file,rtp,udp',
            '-fflags', '+genpts',
            '-i', sdpPath,
            '-reset_timestamps', '1',
            '-flush_packets', '1',
            '-c:v', 'copy',        // Copy video codec
            '-c:a', 'copy',        // Copy audio codec
            '-f', 'matroska',      // Output format
            '-cluster_size_limit', '2M',
            '-cluster_time_limit', '5000',
            filePath
        ];

        const ffmpeg = spawn(FFmpegStatic, ffmpegArgs);

        let ffmpegLogs = '';
        ffmpeg.stderr.on('data', data => {
            const logData = data.toString();
            ffmpegLogs += logData;
            console.log('FFmpeg:', logData);
        });

        ffmpeg.on('error', error => {
            console.error('FFmpeg error:', error);
            console.error('FFmpeg logs:', ffmpegLogs);
        });

        ffmpeg.on('exit', (code, signal) => {
            console.log('FFmpeg exit with code:', code, 'signal:', signal);
            if (code !== 0) {
                console.error('FFmpeg full logs:', ffmpegLogs);
            }
            if (fs.existsSync(sdpPath)) {
                fs.unlinkSync(sdpPath);
            }
        });

        // Connect both transports
        await audioTransport.connect({
            ip: '127.0.0.1',
            port: 20000
        });

        await videoTransport.connect({
            ip: '127.0.0.1',
            port: 20002
        });

        // Store recording information
        recordings.set(`${audioProducer.id}_${videoProducer.id}`, {
            audioTransport,
            videoTransport,
            audioConsumer,
            videoConsumer,
            ffmpeg,
            filePath,
            sdpPath,
            ffmpegLogs
        });

        return fileName;
    } catch (error) {
        console.error('Error starting combined recording:', error);
        throw error;
    }
};

export const stopCombinedRecording = async (audioProducerId, videoProducerId) => {
    const recordingKey = `${audioProducerId}_${videoProducerId}`;
    const recording = recordings.get(recordingKey);
    if (!recording) return;

    const {
        audioTransport,
        videoTransport,
        audioConsumer,
        videoConsumer,
        ffmpeg,
        filePath,
        sdpPath
    } = recording;

    return new Promise((resolve) => {
        ffmpeg.on('exit', () => {
            // Clean up after FFmpeg exits
            audioConsumer.close();
            videoConsumer.close();
            audioTransport.close();
            videoTransport.close();

            if (fs.existsSync(sdpPath)) {
                fs.unlinkSync(sdpPath);
            }

            recordings.delete(recordingKey);
            resolve(filePath);
        });

        ffmpeg.kill('SIGINT');
    });
};