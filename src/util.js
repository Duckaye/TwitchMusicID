import fs from 'fs';
import download from 'download';

import { fetchTwitchClient, fetchChatClient } from './setup.js';

// export const tzOffset = 1000 * 60 * (new Date()).getTimezoneOffset();
export const tzOffset = 1000 * 60 * -60;

// export const dString = date => `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()} ${date.getHours()}:${date.getMinutes()}:${date.getSeconds()}`;
export const dString = (date = new Date()) => {
    const iso = new Date(date.getTime() - tzOffset).toISOString();
    return `${iso.substr(0, 10)} ${iso.substr(11, 8)}`;
};

export const sendMessage = (chatClient, channel, ...messages) => {
    let message = messages.join(' ');
    if (message.length > 499) message = `${message.substr(0, 496)}...`;

    let logMessage;
    const dateString = dString();
    if (message[0] === '\n') {
        const startingWs = message.match(/\n+/)[0];
        logMessage = `${startingWs}[${dateString}] ${message.substring(startingWs.length)}`;
    } else {
        logMessage = `[${dateString}] ${message}`;
    }

    console.log(logMessage);
    return chatClient.say(channel, message);
};

export const toUtcDate = dateStr => new Date(`${dateStr.replace(' ', 'T')}.000Z`);

export const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export const chunkBy = (arr, size) => arr.reduce((all, one, i) => {
    const ch = Math.floor(i / size);
    all[ch] = [].concat(all[ch] || [], one);
    return all;
}, []);

export const makeDocumentFromClip = (clip, identified = false) => {
    const clipDocument = {
        slug: clip.id,
        creationStamp: +clip.creationDate,
        views: clip.views,
        channel: 'buddha',
        identified,
    };

    if (clip.fingerprintFailed) {
        clipDocument.fingerprintFailed = true;
    }

    if (clip.song) {
        clipDocument.song = {
            artists: clip.song.artists,
            title: clip.song.title,
            label: clip.song.label,
        };
    }

    return clipDocument;
};

export const fetchClips = (userId, filter) => { // Promise
    filter = { ...filter };
    if (filter.startDate !== undefined && typeof filter.startDate !== 'object') filter.startDate = new Date(filter.startDate);
    if (filter.endDate !== undefined && typeof filter.endDate !== 'object') filter.endDate = new Date(filter.endDate);
    const twitchClient = fetchTwitchClient();
    return twitchClient.helix.clips.getClipsForBroadcaster(userId, filter);
};

export const fetchClipsPages = (userId, filter) => { // HelixPaginatedRequest
    filter = { ...filter };
    if (filter.startDate !== undefined && typeof filter.startDate !== 'object') filter.startDate = new Date(filter.startDate);
    if (filter.endDate !== undefined && typeof filter.endDate !== 'object') filter.endDate = new Date(filter.endDate);
    const twitchClient = fetchTwitchClient();
    return twitchClient.helix.clips.getClipsForBroadcasterPaginated(userId, filter);
};

export const fetchClipById = (id) => {
    const twitchClient = fetchTwitchClient();
    return twitchClient.helix.clips.getClipById(id);
};

export const downloadFile = (url, dest) => new Promise((resolve, reject) => {
    const file = fs.createWriteStream(dest);
    download(url).pipe(file);

    file.on('finish', () => {
        resolve();
    });

    file.on('error', (err) => {
        file.close();

        if (err.code !== 'EEXIST') {
            fs.unlink(dest, () => {}); // Delete temp file
        }

        reject(err.message);
    });
});
