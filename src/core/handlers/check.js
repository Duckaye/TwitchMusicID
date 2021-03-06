/* eslint-disable no-await-in-loop */
// import util from 'util';
import fs from 'fs';
import axios from 'axios';

import { fetchAuth } from '../../setup.js';
import {
    sendMessage, delay, chunkBy, downloadFile, fetchChannelId,
} from '../../util.js';
import { fingerprint, identify } from '../identification.js';

// const useSearchPeriod = false;
// const searchPeriod = 1000 * 60 * 60 * 24 * 7;
const pages = 1; // <= 100 clips
const skipPages = 0;
const skipClips = 0; // If both skipPages and skipClips are above 0, the one which skips the most clips is used
const chunkSize = 3;
const delayTime = 1000 * 3;
const batches = 1;

const checkClips = async (twitchClient, chatClient, channel, startDate, endDate, channelId) => {
    const { clientId2 } = await fetchAuth();

    let scanningBlockedAll = false;

    // if (useSearchPeriod) {
    //     endDate = new Date().toISOString();
    //     startDate = new Date(Date.now() - searchPeriod).toISOString();
    // }

    console.log('Fetching clips!');

    const clipsRequest = twitchClient.helix.clips.getClipsForBroadcasterPaginated(channelId, { startDate, endDate });

    let i = 0;
    let minDateStamp = Infinity;
    let maxDateStamp = 0;

    const clipStamps = [];

    for (let iter = 0; iter < pages; iter++) {
        if (scanningBlockedAll) break;

        console.log('[Starting page]:', iter + 1);

        let clipsCollection = await clipsRequest.getNext();
        if (!clipsCollection.length) break;

        [minDateStamp, maxDateStamp] = clipsCollection.reduce(
            (acc, clip) => {
                const clipStamp = +clip.creationDate;
                clipStamps.push(clipStamp);
                return [Math.min(acc[0], clipStamp), Math.max(acc[1], clipStamp)];
            },
            [minDateStamp, maxDateStamp]
        );

        if (iter < skipPages) {
            i += clipsCollection.length;
            continue;
        }

        // clipsCollection = clipsCollection.splice(45);

        clipsCollection = chunkBy(clipsCollection, chunkSize);

        // clipsCollection = [[await twitchClient.helix.clips.getClipById('AwkwardSpeedyIcecreamKevinTurtle')]];

        for (const clips of clipsCollection) {
            if (scanningBlockedAll) break;

            let didScan = false;

            await Promise.all(
                // eslint-disable-next-line no-loop-func
                clips.map(async (clip) => {
                    const clipNum = ++i;

                    console.log('Clip', clipNum, '||', clip.id, '||', clip.title, '||', clip.views, 'views');
                    if (clipNum <= skipClips) return false;

                    const fingerPath = `./src/mp4/${clip.id}.mp4.cli.lo`;
                    const fingerExistsPre = fs.existsSync(`./src/mp4/${clip.id}.mp4.cli.lo`);

                    if (fingerExistsPre) {
                        console.log('>', clipNum, 'Fingerprint already exists, lets use it...');
                    } else {
                        console.log('>', clipNum, 'No fingerprint found, lets make one...');

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

                        console.log('>', clipNum, 'Fetched clip mp4 urls');

                        clip.mp4Name = `${clip.id}.mp4`;
                        clip.mp4Path = `./src/mp4/${clip.mp4Name}`;

                        await downloadFile(clip.mp4Url, clip.mp4Path);

                        console.log('>', clipNum, 'Saved mp4s to file system');

                        const failed = await fingerprint(clipNum, clip.mp4Name);

                        fs.unlinkSync(clip.mp4Path);

                        if (typeof failed === 'object') {
                            clip.scanningBlocked = true;
                            clip.song = { title: 'Audio fingerprinting failed', label: '', artists: [] };
                        }
                    }

                    if (fingerExistsPre) {
                        // clip.song = { title: 'Already scanned', label: '', artists: [] };
                        return false;
                    }

                    if (scanningBlockedAll) return false;

                    if (!clip.scanningBlocked) {
                        didScan = true;
                        const songData = await identify(clipNum, fingerPath);

                        console.log('>', clipNum, 'Checked for song data');

                        if (songData.status.code != 0) {
                            if (songData.status.code == 1001) return false;

                            if (songData.status.code == 3015) {
                                scanningBlockedAll = true;
                            }

                            clip.song = { title: songData.status.msg, label: '', artists: [] };
                        }

                        clip.song = songData.metadata.music[0];
                    }

                    console.log('>', clipNum, 'Outputting', clipNum, '||', clip.id, '||', clip.title, '||', clip.views, 'views');
                    let outStr = `${clipNum} | ${String(clip.creationDate).substr(0, 15)} | ${clip.url} | ${clip.views} views`;

                    if (clip.song) {
                        outStr = `${outStr} ---> ${clip.song.artists.map(artist => artist.name)} | ${clip.song.title} | ${clip.song.label}`;
                        sendMessage(chatClient, channel, outStr);
                    // } else {
                        // outStr = `${outStr} ---> No songs found`;
                    }

                    return true;
                })
            );

            // return; // end early

            if (didScan) {
                await delay(delayTime);
            }
        }

        console.log('[Checked page]:', iter + 1);
    }

    return { minDateStamp, maxDateStamp, clipStamps };
};

export default {
    cmds: ['check'],
    desc: 'Test command; Check clips',
    params: [],

    func: async ({
        twitchClient, chatClient, channel, send, args,
    }) => {
        const channelTargetName = args[0];
        send('Scanning', `${channelTargetName}...`);
        const channelTargetId = await fetchChannelId(channelTargetName);

        console.log('\n\nChecking...');
        sendMessage(chatClient, channel, 'Checking...');

        const partitions = [{ startDate: undefined, endDate: undefined, wealth: 0 }];

        for (let i = 0; i < batches; i++) {
            const partitionIdx = partitions.reduce((acc, partition, idx) => {
                if (acc === null) return idx;
                if (partition.wealth < partitions[acc].wealth) return idx;
                return acc;
            }, null);

            const partition = partitions[partitionIdx];

            console.log('p', partition);

            sendMessage(chatClient, channel, `Starting batch ${i + 1}/${batches}`);

            const { minDateStamp, maxDateStamp, clipStamps } = await checkClips(twitchClient, chatClient, channel, partition.startDate, partition.endDate, channelTargetId);

            sendMessage(chatClient, channel, `Batch ${i + 1} complete`);

            const midStamp = (minDateStamp + maxDateStamp) / 2;
            console.log('minDateStamp, maxDateStamp, clipStamps, midStamp', minDateStamp, maxDateStamp, clipStamps, midStamp);

            const numBefore = clipStamps.reduce((acc, clipStamp) => (clipStamp < midStamp ? acc + 1 : acc), 0);
            const numAfter = clipStamps.reduce((acc, clipStamp) => (clipStamp >= midStamp ? acc + 1 : acc), 0);

            const timeElapsedEachScore = (midStamp - minDateStamp) / 1e9;

            const wealthBefore = numBefore / timeElapsedEachScore;
            const wealthAfter = numAfter / timeElapsedEachScore;

            console.log('numBefore, numAfter, timeElapsedEach, wealthBefore, wealthAfter', numBefore, numAfter, timeElapsedEachScore, wealthBefore, wealthAfter);

            partitions.splice(partitionIdx, 1);

            partitions.push(
                { startDate: new Date(minDateStamp).toISOString(), endDate: new Date(midStamp).toISOString(), wealth: wealthBefore },
                { startDate: new Date(midStamp).toISOString(), endDate: new Date(maxDateStamp).toISOString(), wealth: wealthAfter }
            );

            console.log('partitions', partitions);
        }

        sendMessage(chatClient, channel, 'Checked all!');
        console.log('Checked all!');
    },
};
