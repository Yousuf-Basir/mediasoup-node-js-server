import { spawn } from 'child_process';
import path from 'path';
import fs from 'fs';
import FFmpegStatic from 'ffmpeg-static';

export class StreamHandler {
    constructor() {
        this.activeStreams = new Map();
        // Create temp directory for SDP files if it doesn't exist
        this.tempDir = path.join(process.cwd(), 'temp');
        if (!fs.existsSync(this.tempDir)) {
            fs.mkdirSync(this.tempDir, { recursive: true });
        }
    }

    generateCombinedSdp(audioConsumer, videoConsumer, timestamp) {
        const audioCodec = audioConsumer.rtpParameters.codecs[0];
        const videoCodec = videoConsumer.rtpParameters.codecs[0];
        const audioSsrc = audioConsumer.rtpParameters.encodings[0].ssrc;
        const videoSsrc = videoConsumer.rtpParameters.encodings[0].ssrc;

        const videoFmtpLine = videoCodec.parameters ? 
            Object.entries(videoCodec.parameters)
                .map(([key, value]) => `${key}=${value}`)
                .join(';') : 
            'x-google-min-bitrate=1000;x-google-max-bitrate=3000;x-google-start-bitrate=2000';

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
a=fmtp:${videoCodec.payloadType} ${videoFmtpLine}
a=recvonly
a=rtcp-mux
a=ssrc:${videoSsrc} cname:FFmpeg
a=ssrc:${videoSsrc} msid:FFmpeg FFmpeg
a=ssrc:${videoSsrc} mslabel:FFmpeg
a=ssrc:${videoSsrc} label:FFmpeg`;

        const sdpPath = path.join(this.tempDir, `${timestamp}_combined.sdp`);
        fs.writeFileSync(sdpPath, sdp.replace(/\r\n/g, '\n'));
        
        return sdpPath;
    }

    startFFmpegStream(sdpPath, streamKey) {
        console.log('Starting FFmpeg stream with SDP:', sdpPath);
        
        const ffmpegArgs = [
            '-protocol_whitelist', 'file,rtp,udp',
            '-re',
            '-i', sdpPath,
            '-c:v', 'libx264',
            '-preset', 'veryfast',
            '-b:v', '3000k',
            '-maxrate', '3000k',
            '-bufsize', '6000k',
            '-pix_fmt', 'yuv420p',
            '-g', '60',
            '-profile:v', 'main',
            '-c:a', 'aac',
            '-ar', '44100',
            '-ac', '1',
            '-b:a', '128k',
            '-f', 'flv',
            `rtmp://localhost/live/${streamKey}`
        ];

        const ffmpeg = spawn(FFmpegStatic, ffmpegArgs);
        
        ffmpeg.stdout.on('data', (data) => {
            console.log('FFmpeg stdout:', data.toString());
        });

        ffmpeg.stderr.on('data', (data) => {
            console.log('FFmpeg stderr:', data.toString());
        });

        ffmpeg.on('error', (error) => {
            console.error('FFmpeg error:', error);
        });

        return ffmpeg;
    }
}

// Export functions for starting and stopping streams
export const startStreaming = async (audioProducer, videoProducer, roomName, peerId, router) => {
    try {
        const streamHandler = new StreamHandler();
        const timestamp = Date.now();
        const streamKey = `${roomName}_${peerId}_${timestamp}`;

        // Create transports
        const audioTransport = await router.createPlainTransport({
            listenIp: { ip: '127.0.0.1', announcedIp: null },
            rtcpMux: true,
            comedia: false
        });

        const videoTransport = await router.createPlainTransport({
            listenIp: { ip: '127.0.0.1', announcedIp: null },
            rtcpMux: true,
            comedia: false
        });

        // Create consumers
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

        // Connect transports
        await audioTransport.connect({
            ip: '127.0.0.1',
            port: 20000
        });

        await videoTransport.connect({
            ip: '127.0.0.1',
            port: 20002
        });

        // Generate SDP and start streaming
        const sdpPath = streamHandler.generateCombinedSdp(audioConsumer, videoConsumer, timestamp);
        const ffmpegProcess = streamHandler.startFFmpegStream(sdpPath, streamKey);

        // Store stream info for cleanup
        streamHandler.activeStreams.set(streamKey, {
            ffmpeg: ffmpegProcess,
            sdpPath,
            audioTransport,
            videoTransport,
            audioConsumer,
            videoConsumer
        });

        return { streamKey, streamHandler };
    } catch (error) {
        console.error('Error starting stream:', error);
        throw error;
    }
};

export const stopStreaming = async (streamKey, streamHandler) => {
    const stream = streamHandler.activeStreams.get(streamKey);
    if (!stream) {
        console.log('No active stream found for key:', streamKey);
        return;
    }

    return new Promise((resolve) => {
        const {
            ffmpeg,
            sdpPath,
            audioTransport,
            videoTransport,
            audioConsumer,
            videoConsumer
        } = stream;

        ffmpeg.on('exit', () => {
            // Cleanup
            audioConsumer.close();
            videoConsumer.close();
            audioTransport.close();
            videoTransport.close();

            if (fs.existsSync(sdpPath)) {
                fs.unlinkSync(sdpPath);
            }

            streamHandler.activeStreams.delete(streamKey);
            resolve();
        });

        ffmpeg.kill('SIGINT');
    });
};