const { exec } = require('child_process');
const http = require('http');
const https = require('https');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = process.env.PORT || 3000;

// Helper to run yt-dlp command
function runYtDlp(args) {
  return new Promise((resolve, reject) => {
    const cookiesFlag = process.env.YT_COOKIES ? `--cookies /tmp/cookies.txt` : '';
    const cmd = `yt-dlp ${cookiesFlag} ${args}`;
    console.log('Running:', cmd);
    exec(cmd, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        console.error('yt-dlp error:', stderr);
        reject(new Error(stderr || err.message));
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

// Write cookies to file if env var exists
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
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(200);
    res.end();
    return;
  }

  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const query = parsed.query;

  // Health check
  if (pathname === '/') {
    res.writeHead(200);
    res.end(JSON.stringify({ status: 'ok', message: 'yt-dlp server running' }));
    return;
  }

  // GET /download?url=...&format=mp4&quality=720p
  if (pathname === '/download') {
    const videoUrl = query.url;
    const format = query.format || 'mp4';
    const quality = query.quality || '720p';

    if (!videoUrl) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    try {
      let downloadUrl;

      if (format === 'mp3') {
        // Get best audio URL
        const result = await runYtDlp(
          `-f "bestaudio[ext=m4a]/bestaudio" --get-url "${videoUrl}"`
        );
        downloadUrl = result.split('\n')[0];
        res.writeHead(200);
        res.end(JSON.stringify({ downloadUrl, format: 'mp3' }));

      } else {
        // Get progressive MP4 with audio at requested quality
        const qualityNum = quality.replace('p', '');

        // Try to get merged format first
        let result;
        try {
          result = await runYtDlp(
            `-f "bestvideo[height<=${qualityNum}][ext=mp4]+bestaudio[ext=m4a]/best[height<=${qualityNum}][ext=mp4]/best[ext=mp4]" --get-url "${videoUrl}"`
          );
        } catch(e) {
          result = await runYtDlp(
            `-f "best[ext=mp4]/best" --get-url "${videoUrl}"`
          );
        }

        // yt-dlp returns 2 URLs when merging (video + audio) — we need to proxy merge
        const urls = result.split('\n').filter(u => u.startsWith('http'));

        if (urls.length === 2) {
          // Return both for frontend info, but signal that we need server-side merge
          // For now return the video URL and audio URL separately
          res.writeHead(200);
          res.end(JSON.stringify({
            downloadUrl: urls[0],
            audioUrl: urls[1],
            needsMerge: true,
            quality
          }));
        } else {
          res.writeHead(200);
          res.end(JSON.stringify({ downloadUrl: urls[0], quality }));
        }
      }

    } catch (err) {
      console.error('Download error:', err.message);
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to get download URL: ' + err.message }));
    }
    return;
  }

  // GET /info?url=...
  if (pathname === '/info') {
    const videoUrl = query.url;
    if (!videoUrl) {
      res.writeHead(400);
      res.end(JSON.stringify({ error: 'Missing url parameter' }));
      return;
    }

    try {
      const result = await runYtDlp(`--dump-json --no-playlist "${videoUrl}"`);
      const info = JSON.parse(result);
      res.writeHead(200);
      res.end(JSON.stringify({
        title: info.title,
        thumbnail: info.thumbnail,
        duration: info.duration,
        videoId: info.id,
        qualities: ['360p', '480p', '720p', '1080p']
      }));
    } catch (err) {
      res.writeHead(500);
      res.end(JSON.stringify({ error: 'Failed to fetch info: ' + err.message }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Not found' }));
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
