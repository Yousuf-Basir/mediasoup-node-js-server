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

const generateSdp = (consumer, port) => {
    const { rtpParameters } = consumer;
    const { codecs, encodings } = rtpParameters;
    const codec = codecs[0];
    const payload = codec.payloadType;
    const ssrc = encodings[0].ssrc;
    const mediaType = consumer.kind === 'audio' ? 'audio' : 'video';

    const sdp = `v=0
o=- 0 0 IN IP4 127.0.0.1
s=FFmpeg
c=IN IP4 127.0.0.1
t=0 0
m=${mediaType} ${port} RTP/AVPF ${payload}
a=rtcp:${port}
a=rtpmap:${payload} ${codec.mimeType.split('/')[1]}/${codec.clockRate}${codec.channels ? '/' + codec.channels : ''}
a=recvonly
a=rtcp-mux
a=ssrc:${ssrc} cname:FFmpeg
a=ssrc:${ssrc} msid:FFmpeg FFmpeg
a=ssrc:${ssrc} mslabel:FFmpeg
a=ssrc:${ssrc} label:FFmpeg
${mediaType === 'video' ? 'a=fmtp:' + payload + ' x-google-min-bitrate=1000;x-google-max-bitrate=3000;x-google-start-bitrate=2000' : ''}`;

    return sdp.split('\n').map(line => line.trim()).join('\n');
};

const createPlainRtpTransport = async (router) => {
    return await router.createPlainTransport({
        listenIp: { ip: '127.0.0.1', announcedIp: null },
        rtcpMux: true,
        comedia: false
    });
};

export const startRecording = async (producer, roomName, peerId, rooms) => {
    const router = rooms[roomName].router;

    try {
        const transport = await createPlainRtpTransport(router);
        
        const consumer = await transport.consume({
            producerId: producer.id,
            rtpCapabilities: router.rtpCapabilities,
            paused: false
        });

        const timestamp = new Date().getTime();
        const fileName = `${roomName}_${peerId}_${consumer.kind}_${timestamp}.${consumer.kind === 'video' ? 'mkv' : 'opus'}`;
        const filePath = path.join(recordingsPath, fileName);

        const port = consumer.kind === 'audio' ? 20000 : 20002;

        const sdpContent = generateSdp(consumer, port);
        const sdpPath = path.join(recordingsPath, `${timestamp}.sdp`);
        
        fs.writeFileSync(sdpPath, sdpContent.replace(/\r\n/g, '\n'));

        // Modified FFmpeg arguments for real-time recording
        let ffmpegArgs = [
            '-loglevel', 'debug',
            '-protocol_whitelist', 'file,rtp,udp',
            '-fflags', '+genpts',
            '-i', sdpPath,
            '-reset_timestamps', '1',        // Reset timestamps to ensure proper playback
            '-flush_packets', '1'            // Flush packets immediately
        ];

        if (consumer.kind === 'video') {
            ffmpegArgs = ffmpegArgs.concat([
                '-c:v', 'copy',
                '-an',
                '-movflags', '+faststart+frag_keyframe+empty_moov+default_base_moof',  // Enable streaming-friendly MP4
                '-f', 'matroska',            // MKV format handles real-time better than MP4
                '-cluster_size_limit', '2M',  // Small cluster size for frequent writes
                '-cluster_time_limit', '5000' // Write clusters every 5 seconds
            ]);
        } else {
            ffmpegArgs = ffmpegArgs.concat([
                '-c:a', 'copy',
                '-vn',
                '-f', 'opus',
                '-flush_packets', '1'         // Immediate packet writing for audio
            ]);
        }

        ffmpegArgs.push(filePath);

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

        // Connect transport
        await transport.connect({
            ip: '127.0.0.1',
            port: port
        });

        // Store recording information
        recordings.set(producer.id, {
            transport,
            consumer,
            ffmpeg,
            filePath,
            sdpPath,
            ffmpegLogs
        });

        return fileName;
    } catch (error) {
        console.error('Error starting recording:', error);
        throw error;
    }
};

export const stopRecording = async (producerId) => {
    const recording = recordings.get(producerId);
    if (!recording) return;
  
    const { transport, consumer, ffmpeg, filePath, sdpPath } = recording;
  
    // Gracefully stop FFmpeg with SIGINT
    return new Promise((resolve) => {
        ffmpeg.on('exit', () => {
            // Clean up after FFmpeg exits
            consumer.close();
            transport.close();
            
            if (fs.existsSync(sdpPath)) {
                fs.unlinkSync(sdpPath);
            }
            
            recordings.delete(producerId);
            resolve(filePath);
        });
        
        ffmpeg.kill('SIGINT');
    });
};