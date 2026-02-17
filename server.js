const express = require('express');
const axios = require('axios');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Initialize SQLite Database
const dbPath = path.join(__dirname, 'videos.db');
const db = new sqlite3.Database(dbPath);

// Create tables if they don't exist
db.serialize(() => {
  db.run(`
    CREATE TABLE IF NOT EXISTS videos (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT UNIQUE NOT NULL,
      title TEXT,
      channel_name TEXT,
      thumbnail_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS view_counts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      view_count INTEGER,
      like_count INTEGER,
      comment_count INTEGER,
      timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY(video_id) REFERENCES videos(video_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS email_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      email TEXT NOT NULL,
      notify_enabled BOOLEAN DEFAULT 1,
      min_view_change INTEGER DEFAULT 0,
      last_notified DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(video_id, email),
      FOREIGN KEY(video_id) REFERENCES videos(video_id)
    )
  `);

  db.run(`
    CREATE TABLE IF NOT EXISTS notification_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      video_id TEXT NOT NULL,
      email TEXT NOT NULL,
      view_count INTEGER,
      like_count INTEGER,
      comment_count INTEGER,
      sent_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )
  `);
});

// YouTube API key from environment variable
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

// Email configuration
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASSWORD
  }
});

console.log('API Key Status:', YOUTUBE_API_KEY ? 'LOADED ✓' : 'NOT FOUND ✗');
console.log('Email Service:', process.env.EMAIL_USER ? 'CONFIGURED ✓' : 'NOT CONFIGURED');

// Helper function to extract video ID from YouTube URL
function extractVideoId(url) {
  const regex = /(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/)([^&\n?#]+)/;
  const match = url.match(regex);
  return match ? match[1] : null;
}

// Helper function to get video stats from YouTube API
async function getVideoStats(videoId) {
  try {
    const response = await axios.get('https://www.googleapis.com/youtube/v3/videos', {
      params: {
        part: 'statistics,snippet',
        id: videoId,
        key: YOUTUBE_API_KEY
      }
    });

    if (response.data.items.length === 0) {
      throw new Error('Video not found');
    }

    const item = response.data.items[0];
    return {
      videoId,
      title: item.snippet.title,
      channelName: item.snippet.channelTitle,
      thumbnailUrl: item.snippet.thumbnails.default.url,
      viewCount: parseInt(item.statistics.viewCount || 0),
      likeCount: parseInt(item.statistics.likeCount || 0),
      commentCount: parseInt(item.statistics.commentCount || 0)
    };
  } catch (error) {
    console.error('Error fetching video stats:', error.message);
    throw error;
  }
}

// Send email notification
async function sendEmailNotification(email, videoTitle, stats, previousStats) {
  try {
    const viewChange = stats.viewCount - (previousStats?.viewCount || 0);
    const likeChange = stats.likeCount - (previousStats?.likeCount || 0);
    const commentChange = stats.commentCount - (previousStats?.commentCount || 0);

    const htmlContent = `
      <h2>📊 YouTube Video Update Notification</h2>
      <h3>${videoTitle}</h3>
      
      <table style="border-collapse: collapse; width: 100%; margin-top: 20px;">
        <tr style="background-color: #f2f2f2;">
          <th style="border: 1px solid #ddd; padding: 10px; text-align: left;">Metric</th>
          <th style="border: 1px solid #ddd; padding: 10px; text-align: left;">Current</th>
          <th style="border: 1px solid #ddd; padding: 10px; text-align: left;">Change</th>
        </tr>
        <tr>
          <td style="border: 1px solid #ddd; padding: 10px;">👁️ Views</td>
          <td style="border: 1px solid #ddd; padding: 10px;"><strong>${stats.viewCount.toLocaleString()}</strong></td>
          <td style="border: 1px solid #ddd; padding: 10px;"><span style="color: ${viewChange > 0 ? 'green' : 'gray'};">+${viewChange.toLocaleString()}</span></td>
        </tr>
        <tr style="background-color: #f9f9f9;">
          <td style="border: 1px solid #ddd; padding: 10px;">👍 Likes</td>
          <td style="border: 1px solid #ddd; padding: 10px;"><strong>${stats.likeCount.toLocaleString()}</strong></td>
          <td style="border: 1px solid #ddd; padding: 10px;"><span style="color: ${likeChange > 0 ? 'green' : 'gray'};">+${likeChange.toLocaleString()}</span></td>
        </tr>
        <tr>
          <td style="border: 1px solid #ddd; padding: 10px;">💬 Comments</td>
          <td style="border: 1px solid #ddd; padding: 10px;"><strong>${stats.commentCount.toLocaleString()}</strong></td>
          <td style="border: 1px solid #ddd; padding: 10px;"><span style="color: ${commentChange > 0 ? 'green' : 'gray'};">+${commentChange.toLocaleString()}</span></td>
        </tr>
      </table>

      <p style="margin-top: 20px; color: #666;">
        <em>This is an automated notification from YouTube Live Count Tracker.<br>
        Check your dashboard for more details: youtubelivecount.com</em>
      </p>
    `;

    await transporter.sendMail({
      from: process.env.EMAIL_USER,
      to: email,
      subject: `📈 ${videoTitle} - New Updates (Views: +${viewChange.toLocaleString()})`,
      html: htmlContent
    });

    console.log(`✉️ Email sent to ${email} for video: ${videoTitle}`);
    return true;
  } catch (error) {
    console.error('Error sending email:', error.message);
    return false;
  }
}

// Check for updates and send notifications
async function checkAndNotifyUpdates() {
  try {
    db.all('SELECT * FROM email_subscriptions WHERE notify_enabled = 1', async (err, subscriptions) => {
      if (err || !subscriptions) return;

      for (const subscription of subscriptions) {
        try {
          const stats = await getVideoStats(subscription.video_id);

          // Get previous stats
          db.get(
            'SELECT * FROM view_counts WHERE video_id = ? ORDER BY timestamp DESC LIMIT 1',
            [subscription.video_id],
            async (err, previousStats) => {
              if (!err && previousStats) {
                const hasSignificantChange =
                  stats.viewCount > previousStats.view_count ||
                  stats.likeCount > previousStats.like_count ||
                  stats.commentCount > previousStats.comment_count;

                if (hasSignificantChange) {
                  // Get video title
                  db.get(
                    'SELECT title FROM videos WHERE video_id = ?',
                    [subscription.video_id],
                    async (err, video) => {
                      if (!err && video) {
                        await sendEmailNotification(
                          subscription.email,
                          video.title,
                          stats,
                          previousStats
                        );

                        // Update last notified timestamp
                        db.run(
                          'UPDATE email_subscriptions SET last_notified = datetime("now") WHERE video_id = ? AND email = ?',
                          [subscription.video_id, subscription.email]
                        );

                        // Log notification
                        db.run(
                          'INSERT INTO notification_history (video_id, email, view_count, like_count, comment_count) VALUES (?, ?, ?, ?, ?)',
                          [subscription.video_id, subscription.email, stats.viewCount, stats.likeCount, stats.commentCount]
                        );
                      }
                    }
                  );
                }
              }
            }
          );
        } catch (error) {
          console.error(`Error checking updates for ${subscription.video_id}:`, error.message);
        }
      }
    });
  } catch (error) {
    console.error('Error in notification check:', error.message);
  }
}

// Schedule notification checks every 15 minutes
setInterval(checkAndNotifyUpdates, 15 * 60 * 1000); // 15 minutes

// API Endpoints

// Add a new video to track
app.post('/api/videos', async (req, res) => {
  const { url } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'YouTube API key not configured' });
  }

  try {
    const videoId = extractVideoId(url);
    if (!videoId) {
      return res.status(400).json({ error: 'Invalid YouTube URL' });
    }

    const stats = await getVideoStats(videoId);

    // Insert video into database
    db.run(
      'INSERT OR IGNORE INTO videos (video_id, title, channel_name, thumbnail_url) VALUES (?, ?, ?, ?)',
      [stats.videoId, stats.title, stats.channelName, stats.thumbnailUrl],
      function(err) {
        if (err) {
          console.error('DB Insert Error:', err);
          return res.status(500).json({ error: 'Failed to add video' });
        }

        // Record initial view count
        db.run(
          'INSERT INTO view_counts (video_id, view_count, like_count, comment_count) VALUES (?, ?, ?, ?)',
          [stats.videoId, stats.viewCount, stats.likeCount, stats.commentCount],
          (err) => {
            if (err) {
              console.error('View Count Insert Error:', err);
              return res.status(500).json({ error: 'Failed to record view count' });
            }

            res.json({
              success: true,
              video: {
                videoId: stats.videoId,
                title: stats.title,
                channelName: stats.channelName,
                thumbnailUrl: stats.thumbnailUrl,
                viewCount: stats.viewCount,
                likeCount: stats.likeCount,
                commentCount: stats.commentCount
              }
            });
          }
        );
      }
    );
  } catch (error) {
    console.error('API Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Get all tracked videos
app.get('/api/videos', (req, res) => {
  db.all('SELECT * FROM videos ORDER BY created_at DESC', (err, rows) => {
    if (err) {
      console.error('Fetch Videos Error:', err);
      return res.status(500).json({ error: 'Failed to fetch videos' });
    }

    if (!rows || rows.length === 0) {
      return res.json([]);
    }

    // Get latest stats for each video
    Promise.all(
      rows.map(video => {
        return new Promise((resolve, reject) => {
          db.get(
            'SELECT * FROM view_counts WHERE video_id = ? ORDER BY timestamp DESC LIMIT 1',
            [video.video_id],
            (err, latestStats) => {
              if (err) {
                console.error('Fetch Stats Error:', err);
                reject(err);
              } else {
                resolve({ ...video, latestStats });
              }
            }
          );
        });
      })
    )
      .then(videosWithStats => res.json(videosWithStats))
      .catch(error => {
        console.error('Promise Error:', error);
        res.status(500).json({ error: 'Failed to fetch videos' });
      });
  });
});

// Get historical data for a specific video
app.get('/api/videos/:videoId/history', (req, res) => {
  const { videoId } = req.params;
  const limit = req.query.limit || 100;

  db.all(
    'SELECT * FROM view_counts WHERE video_id = ? ORDER BY timestamp ASC LIMIT ?',
    [videoId, limit],
    (err, rows) => {
      if (err) {
        console.error('History Fetch Error:', err);
        return res.status(500).json({ error: 'Failed to fetch history' });
      }
      res.json(rows || []);
    }
  );
});

// Manual refresh - get latest stats for a video
app.post('/api/videos/:videoId/refresh', async (req, res) => {
  const { videoId } = req.params;

  if (!YOUTUBE_API_KEY) {
    return res.status(500).json({ error: 'YouTube API key not configured' });
  }

  try {
    const stats = await getVideoStats(videoId);

    // Record new view count
    db.run(
      'INSERT INTO view_counts (video_id, view_count, like_count, comment_count) VALUES (?, ?, ?, ?)',
      [stats.videoId, stats.viewCount, stats.likeCount, stats.commentCount],
      (err) => {
        if (err) {
          console.error('Refresh Insert Error:', err);
          return res.status(500).json({ error: 'Failed to record view count' });
        }

        res.json({
          success: true,
          data: {
            viewCount: stats.viewCount,
            likeCount: stats.likeCount,
            commentCount: stats.commentCount,
            timestamp: new Date()
          }
        });
      }
    );
  } catch (error) {
    console.error('Refresh Error:', error.message);
    res.status(500).json({ error: error.message });
  }
});

// Subscribe to email notifications
app.post('/api/videos/:videoId/subscribe', (req, res) => {
  const { videoId } = req.params;
  const { email } = req.body;

  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Valid email required' });
  }

  db.run(
    'INSERT OR REPLACE INTO email_subscriptions (video_id, email, notify_enabled) VALUES (?, ?, 1)',
    [videoId, email],
    (err) => {
      if (err) {
        console.error('Subscribe Error:', err);
        return res.status(500).json({ error: 'Failed to subscribe' });
      }

      res.json({
        success: true,
        message: `Subscribed ${email} to notifications for this video!`
      });
    }
  );
});

// Unsubscribe from email notifications
app.post('/api/videos/:videoId/unsubscribe', (req, res) => {
  const { videoId } = req.params;
  const { email } = req.body;

  db.run(
    'DELETE FROM email_subscriptions WHERE video_id = ? AND email = ?',
    [videoId, email],
    (err) => {
      if (err) {
        console.error('Unsubscribe Error:', err);
        return res.status(500).json({ error: 'Failed to unsubscribe' });
      }

      res.json({ success: true, message: 'Unsubscribed successfully' });
    }
  );
});

// Get subscribed emails for a video
app.get('/api/videos/:videoId/subscribers', (req, res) => {
  const { videoId } = req.params;

  db.all(
    'SELECT email, last_notified FROM email_subscriptions WHERE video_id = ? AND notify_enabled = 1',
    [videoId],
    (err, rows) => {
      if (err) {
        console.error('Fetch Subscribers Error:', err);
        return res.status(500).json({ error: 'Failed to fetch subscribers' });
      }

      res.json(rows || []);
    }
  );
});

// Delete a video from tracking
app.delete('/api/videos/:videoId', (req, res) => {
  const { videoId } = req.params;

  db.run('DELETE FROM videos WHERE video_id = ?', [videoId], (err) => {
    if (err) {
      console.error('Delete Video Error:', err);
      return res.status(500).json({ error: 'Failed to delete video' });
    }

    db.run('DELETE FROM view_counts WHERE video_id = ?', [videoId], (err) => {
      if (err) {
        console.error('Delete Stats Error:', err);
        return res.status(500).json({ error: 'Failed to delete video data' });
      }

      db.run('DELETE FROM email_subscriptions WHERE video_id = ?', [videoId]);
      db.run('DELETE FROM notification_history WHERE video_id = ?', [videoId]);

      res.json({ success: true });
    });
  });
});

// Start server
app.listen(PORT, () => {
  console.log(`✓ YouTube Tracker running on http://localhost:${PORT}`);
  console.log(`✓ API Key: ${YOUTUBE_API_KEY ? 'CONFIGURED' : 'NOT SET - Add to .env file'}`);
  console.log(`✓ Email Service: ${process.env.EMAIL_USER ? 'CONFIGURED' : 'NOT SET - Add to .env file'}`);
  console.log('✓ Checking for updates every 15 minutes...');
  console.log('');
  console.log('Ready to track videos! Open http://localhost:5000 in your browser');
});
