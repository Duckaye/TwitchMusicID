import util from 'util';
import { execFile } from 'child_process';
import fs from 'fs';
import crypto from 'crypto';
import axios from 'axios';
import request from 'request';

import { getDb } from '../db.js';
import { fetchAuth } from '../setup.js';
import { downloadFile, getClipsByIds } from '../util.js';
import { host, accessKey, accessSecret } from '../hidden.js';

const execFileAsync = util.promisify(execFile);

const options = {
    host,
    endpoint: '/v1/identify',
    signature_version: '1',
    data_type: 'fingerprint',
    secure: true,
    access_key: accessKey,
    access_secret: accessSecret,
};

export const fingerprint = async (idNum, fileName) => {
    try {
        const { stderr } = await execFileAsync(
            process.platform === 'win32' ? 'acrcloud_extr_win.exe' : './acrcloud_extr_linux',
            ['-cli', '-l', '61', '-i', `./mp4/${fileName}`, '--debug'],
            { cwd: './src' }
        );

        if (stderr && stderr.includes('create fingerprint error ')) {
            console.log('###', idNum, '[fingerprint] stderr:', stderr);
            return { error: stderr };
        }

        return false;
    } catch (err) {
        console.log('###', idNum, '[fingerprint] Error:', err);
        return true;
    }
};

/**
 * Identifies a sample of bytes
 */
function upload(data) {
    const timestamp = Math.floor((new Date()).getTime() / 1000);

    const signString = ['POST', options.endpoint, accessKey, options.data_type, options.signature_version, timestamp].join('\n');

    const signature = crypto.createHmac('sha1', accessSecret).update(Buffer.from(signString, 'utf-8')).digest().toString('base64'); // sign

    const formData = {
        sample: data,
        access_key: options.access_key,
        data_type: options.data_type,
        signature_version: options.signature_version,
        signature,
        sample_bytes: data.length,
        timestamp,
    };

    // return axios({
    //     method: 'POST',
    //     url: `http://${options.host}${options.endpoint}`,
    //     data: formData,
    //     headers: {
    //         'Content-Type': 'multipart/form-data',
    //     },
    // });

    return new Promise((resolve, reject) => {
        request.post({
            url: `http://${options.host}${options.endpoint}`,
            method: 'POST',
            formData,
            headers: {
                'Content-Type': 'multipart/form-data',
            },
        }, (err, httpResponse, body) => {
            if (err) return reject(err);
            return resolve(JSON.parse(body));
        });
    });
}

export const identify = async (idNum, filePath) => {
    // filePath = './src/mp4/Holiday.mp3.cli.lo';
    console.log('+ Identifying music in', idNum, filePath);

    const bitmap = fs.readFileSync(filePath);

    try {
        const response = await upload(Buffer.from(bitmap));
        console.log('++ ACRCloud Response for', idNum, ':', response, response.status.code == 0 ? response.metadata.music.map(song => `<${song.score}>`).join(', ') : '');

        // if (response.status.code != 0) return false;

        return response;
    } catch (err) {
        console.log('###', idNum, '[identify] Error:', err);
        return null;
    }
};

export const clipsStored = async (clips, clipsCollection = getDb().collection('clips')) => {
    const clipRecords = await clipsCollection.find({ slug: { $in: clips.map(clip => clip.id) } }).project({ slug: 1, _id: 0 }).toArray();
    return clipRecords;
};

export const fetchMp4Data = async (clip, clientId2) => {
    const { data: responseData } = await axios({
        method: 'POST',
        url: 'https://gql.twitch.tv/gql',
        headers: {
            'Client-Id': clientId2,
            'Content-Type': 'text/plain;charset=UTF-8',
        },
        data: [
            {
                operationName: 'VideoAccessToken_Clip',
                // variables: { slug: clip.id },
                variables: { slug: clip.id },
                extensions: {
                    persistedQuery: {
                        version: 1,
                        sha256Hash: '9bfcc0177bffc730bd5a5a89005869d2773480cf1738c592143b5173634b7d15',
                    },
                },
            },
        ],
    });

    const clipData = responseData[0].data.clip;

    if (clipData == null) {
        console.log('>>> No mp4 data for', clip.id);
        getDb().collection('clips').deleteOne({ slug: clip.id }); // If there's no mp4 data it's probably deleted
        return false;
    }

    // Get lowest quality above 400p if available... otherwise highest available.
    const mp4Collection = responseData[0].data.clip.videoQualities
        .map(mp4Data => ({
            ...mp4Data,
            quality: parseInt(mp4Data.quality, 10),
        }))
        .sort((a, b) => b.quality - a.quality);
    const mp4CollectionGood = mp4Collection.filter(mp4Data => mp4Data.quality > 400);
    const mp4Data = mp4CollectionGood.length > 0 ? mp4CollectionGood[mp4CollectionGood.length - 1] : mp4Collection[0];

    clip.mp4Url = mp4Data.sourceURL;

    clip.mp4Name = `${clip.id}.mp4`;
    clip.mp4Path = `./src/mp4/${clip.mp4Name}`;

    return true;
};

let scanningBlockedAll = null;
const resumeScanningAfter = 1000 * 3;

// Extract mp4 for clip
// Fingerprint mp4 audio
// Identify song
// Add metadata to clip
// Return full song data (or null if stopped midway)
export const identifyClip = async (clip, clientId2) => {
    if (scanningBlockedAll) {
        if (+new Date() > scanningBlockedAll) {
            scanningBlockedAll = null;
        } else {
            console.log('[CANCELLING SCAN]', clip.id);
            return false;
        }
    }

    const fingerPath = `./src/mp4/${clip.id}.mp4.cli.lo`;
    const fingerExistsAlready = fs.existsSync(fingerPath);
    if (fingerExistsAlready) { // Fingerprint could exist from a failed identify
        console.log('>> Fingerprint already exists for', clip.id);
        // return true; // undefined
    } else {
        console.log('> No cached fingerprint for', clip.id);
    }

    const mp4Found = await fetchMp4Data(clip, clientId2);

    if (!mp4Found) return false;

    await downloadFile(clip.mp4Url, clip.mp4Path);

    const failed = await fingerprint(clip.id, clip.mp4Name);

    fs.unlinkSync(clip.mp4Path);

    if (failed || typeof failed === 'object') {
        clip.fingerprintFailed = true;
        return true;
    }

    // if (clip.id[0] > 'K') return true;
    // const songData = { status: { code: 0 }, metadata: { music: [{ title: 'test_title', label: 'test_label', artists: ['test_artist'] }] } };
    const songData = await identify(clip.id, fingerPath);

    if (songData.status.code != 0) {
        if (songData.status.code == 3015) {
            scanningBlockedAll = +new Date() + resumeScanningAfter;
        } else if (songData.status.code == 1001) {
            return true;
        }

        console.log('### NOT STORING - BAD ERROR', clip.id);
        return false;
    }

    clip.song = songData.metadata.music[0];

    return songData;
};

export const lookupClip = async (slug) => {
    const clip = (await getClipsByIds([slug]))[0];
    const { clientId2 } = await fetchAuth();
    return identifyClip(clip, clientId2);
};
