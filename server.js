const { exec, spawn } = require('child_process');
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const { pipeline } = require('stream');

const PORT = process.env.PORT || 3000;

function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const cookiesFlag = process.env.YT_COOKIES ? `--cookies /tmp/cookies.txt` : '';
    const cmd = `yt-dlp ${cookiesFlag} ${args}`;
    console.log('Running:', cmd);
    exec(cmd, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) { reject(new Error(stderr || err.message)); }
      else { resolve(stdout.trim()); }
    });
  });
}

function setupCookies() {
  if (process.env.YT_COOKIES) {
    fs.writeFileSync('/tmp/cookies.txt', process.env.YT_COOKIES);
    console.log('Cookies loaded.');
  }
}

setupCookies();

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');

  if (req.method === 'OPTIONS') { res.writeHead(200); res.end(); return; }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  // Health check
  if (pathname === '/') {
    res.setHeader('Content-Type', 'application/json');
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', message: 'yt-dlp server running' }));
    return;
  }

  // GET /info?url=...
  if (pathname === '/info') {
    const videoUrl = query.url;
    if (!videoUrl) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }
    try {
      const result = await runYtDlp(`--dump-json --no-playlist "${videoUrl}"`);
      const info = JSON.parse(result);
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(200);
      res.end(JSON.stringify({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        videoId: info.id,
        qualities: ['360p', '480p', '720p', '1080p']
      }));
    } catch (err) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to fetch info: ' + err.message }));
    }
    return;
  }

  // GET /download?url=...&format=mp4&quality=720p
  if (pathname === '/download') {
    const videoUrl = query.url;
    const format = query.format || 'mp4';
    const quality = query.quality || '720p';

    if (!videoUrl) {
      res.setHeader('Content-Type', 'application/json');
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    try {
      const cookiesFlag = process.env.YT_COOKIES ? `--cookies /tmp/cookies.txt` : '';
      const tmpFile = `/tmp/dl_${Date.now()}`;

      if (format === 'mp3') {
        // Download and convert to mp3
        const outFile = `${tmpFile}.mp3`;
        await new Promise((resolve, reject) => {
          const cmd = `yt-dlp ${cookiesFlag} -f "bestaudio[ext=m4a]/bestaudio" -x --audio-format mp3 --audio-quality 0 -o "${outFile}" "${videoUrl}"`;
          exec(cmd, { timeout: 120000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout);
          });
        });

        if (!fs.existsSync(outFile)) throw new Error('MP3 file not created');

        const stat = fs.statSync(outFile);
        res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Content-Disposition', 'attachment; filename="audio.mp3"');
        res.setHeader('Content-Length', stat.size);
        res.writeHead(200);
        const stream = fs.createReadStream(outFile);
        stream.pipe(res);
        stream.on('end', () => { try { fs.unlinkSync(outFile); } catch(e){} });
        stream.on('error', () => { try { fs.unlinkSync(outFile); } catch(e){} });

      } else {
        // Download merged MP4
        const qualityNum = quality.replace('p', '');
        const outFile = `${tmpFile}.mp4`;

        await new Promise((resolve, reject) => {
          const cmd = `yt-dlp ${cookiesFlag} -f "bestvideo[height<=${qualityNum}][ext=mp4]+bestaudio[ext=m4a]/bestvideo[height<=${qualityNum}]+bestaudio/best[height<=${qualityNum}]" --merge-output-format mp4 -o "${outFile}" "${videoUrl}"`;
          exec(cmd, { timeout: 180000 }, (err, stdout, stderr) => {
            if (err) reject(new Error(stderr || err.message));
            else resolve(stdout);
          });
        });

        if (!fs.existsSync(outFile)) throw new Error('Video file not created');

        const stat = fs.statSync(outFile);
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Disposition', `attachment; filename="video_${quality}.mp4"`);
        res.setHeader('Content-Length', stat.size);
        res.writeHead(200);
        const stream = fs.createReadStream(outFile);
        stream.pipe(res);
        stream.on('end', () => { try { fs.unlinkSync(outFile); } catch(e){} });
        stream.on('error', () => { try { fs.unlinkSync(outFile); } catch(e){} });
      }

    } catch (err) {
      console.error('Download error:', err.message);
      if (!res.headersSent) {
        res.setHeader('Content-Type', 'application/json');
        res.writeHead(500);
        res.end(JSON.stringify({ error: 'Download failed: ' + err.message }));
      }
    }
    return;
  }

  res.setHeader('Content-Type', 'application/json');
  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
