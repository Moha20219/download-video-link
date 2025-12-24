/**
 * Example Node.js backend using yt-dlp to provide /api/info and /api/download
 *
 * Requirements:
 *  - Node 16+
 *  - npm install express cors body-parser
 *  - yt-dlp installed on the host and available in PATH (https://github.com/yt-dlp/yt-dlp)
 *  - (optional) ffmpeg installed for format conversions
 *
 * Notes / Disclaimer:
 *  - This is a simple example for local/self-hosted usage.
 *  - Respect target platforms' terms of service and copyrights.
 *  - For production, add authentication, rate-limits, sanitization and security hardening.
 */

const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');
const { spawn } = require('child_process');
const path = require('path');
const app = express();

app.use(cors());
app.use(bodyParser.json({ limit: '1mb' }));

// Helper: run yt-dlp -J (json) to get info
function ytDlpJson(url) {
    return new Promise((resolve, reject) => {
        const child = spawn('yt-dlp', ['-J', url], { stdio: ['ignore','pipe','pipe'] });
        let out = '', err = '';
        child.stdout.on('data', d => out += d.toString());
        child.stderr.on('data', d => err += d.toString());
        child.on('close', code => {
            if (code === 0) {
                try {
                    const json = JSON.parse(out);
                    resolve(json);
                } catch (e) { reject(e); }
            } else {
                reject(new Error(err || ('yt-dlp exited with ' + code)));
            }
        });
    });
}

// POST /api/info  { url, service? }
// returns JSON: { title, id, uploader, duration, thumbnails, formats: [ { format_id, ext, format, filesize, url } ] }
app.post('/api/info', async (req, res) => {
    const url = req.body.url;
    if (!url) return res.status(400).send('Missing url');

    try {
        const info = await ytDlpJson(url);
        // normalize important parts
        const result = {
            title: info.title,
            id: info.id || info.webpage_url,
            uploader: info.uploader || info.uploader_id || '',
            duration: info.duration ? `${Math.floor(info.duration/60)}m ${info.duration%60}s` : '',
            thumbnails: info.thumbnails || [],
            formats: (info.formats || []).map(f => ({
                format_id: f.format_id,
                format: f.format,
                ext: f.ext,
                filesize: f.filesize,
                url: f.url,
                tbr: f.tbr
            }))
        };
        // sort formats (prefer video+audio mp4)
        result.formats.sort((a,b) => (b.filesize || 0) - (a.filesize || 0));
        // include original page url for download calls
        result.request_url = url;
        res.json(result);
    } catch (err) {
        console.error('info error', err);
        res.status(500).send(String(err.message || err));
    }
});

// GET /api/download?url=...&format_id=...
// Streams the selected format by invoking yt-dlp and piping stdout.
// Note: using -f <format_id> -o - will stream to stdout.
app.get('/api/download', (req, res) => {
    const url = req.query.url;
    const format = req.query.format_id;
    if (!url) return res.status(400).send('Missing url');

    // sanitize (very simple) - in production validate more
    const finalUrl = url;

    // Build command
    const args = [];
    if (format) args.push('-f', format);
    // output to stdout
    args.push('-o', '-');
    // do not print progress to stderr to keep it clean (yt-dlp prints progress there)
    args.push(finalUrl);

    // spawn
    const child = spawn('yt-dlp', args, { stdio: ['ignore','pipe','pipe'] });

    // set headers for download
    res.setHeader('Content-Type', 'application/octet-stream');
    // try set filename from URL or format
    const filename = `download.${format ? format.replace(/[^a-z0-9]/gi, '') : 'media'}`;
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);

    // pipe stdout to response
    child.stdout.pipe(res);

    child.stderr.on('data', d => {
        // optionally log progress; don't forward to response
        console.error('yt-dlp:', d.toString());
    });

    child.on('close', code => {
        console.log('yt-dlp finished with', code);
        try { res.end(); } catch(e){}
    });

    // handle client abort
    req.on('close', () => {
        child.kill('SIGKILL');
    });
});

// static serve frontend if desired
const serveStatic = true;
if (serveStatic) {
    const staticPath = path.join(__dirname, 'public'); // if you put index.html into public/
    app.use(express.static(staticPath));
}

// start
const port = process.env.PORT || 3000;
app.listen(port, () => {
    console.log('Server started on port', port);
    console.log('Ensure yt-dlp is installed and in PATH. Example: yt-dlp -v');
});