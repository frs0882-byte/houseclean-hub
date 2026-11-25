// GitHub Private Repository Cloud DB Helper for HouseClean Hub
const https = require('https');

const DEFAULT_OWNER = process.env.GH_DB_OWNER || 'frs0882-byte';
const DEFAULT_REPO = process.env.GH_DB_REPO || 'houseclean-data';
const STATE_PATH = 'state.json';

function githubRequest(path, method = 'GET', body = null, token = process.env.GH_TOKEN) {
  return new Promise((resolve, reject) => {
    if (!token) {
      return reject(new Error('GH_TOKEN environment variable is not set.'));
    }

    const payload = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path: path,
      method: method,
      headers: {
        'Authorization': `token ${token}`,
        'Accept': 'application/vnd.github.v3+json',
        'User-Agent': 'HouseClean-Hub-Serverless'
      }
    };

    if (payload) {
      options.headers['Content-Type'] = 'application/json';
      options.headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, data: parsed });
        } catch (err) {
          resolve({ status: res.statusCode, data: { raw: data } });
        }
      });
    });

    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function getNowJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().replace('Z', '+09:00');
}

function getTodayYMDJST() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

async function readCloudState() {
  const apiPath = `/repos/${DEFAULT_OWNER}/${DEFAULT_REPO}/contents/${STATE_PATH}`;
  const res = await githubRequest(apiPath, 'GET');

  if (res.status === 404) {
    return {
      sha: null,
      state: {
        version: 1,
        updatedAt: getNowJST(),
        projects: [],
        deletedProjectIds: [],
        contractors: null,
        orderSheetConfig: null,
        lineLogs: []
      }
    };
  }

  if (res.status !== 200) {
    throw new Error(`GitHub API read error (${res.status}): ${JSON.stringify(res.data)}`);
  }

  const contentB64 = res.data.content || '';
  const decoded = Buffer.from(contentB64, 'base64').toString('utf8');
  const parsed = JSON.parse(decoded);

  return {
    sha: res.data.sha,
    state: parsed
  };
}

async function writeCloudState(newState, sha = null, message = 'Update HouseClean Hub cloud state') {
  const apiPath = `/repos/${DEFAULT_OWNER}/${DEFAULT_REPO}/contents/${STATE_PATH}`;
  newState.updatedAt = getNowJST();
  const jsonStr = JSON.stringify(newState, null, 2);
  const b64 = Buffer.from(jsonStr, 'utf8').toString('base64');

  const payload = {
    message,
    content: b64
  };
  if (sha) {
    payload.sha = sha;
  }

  const res = await githubRequest(apiPath, 'PUT', payload);
  return res;
}

// 競合時自動リトライ付きの安全更新関数
async function mutateCloudState(mutatorFn, message = 'Update state', maxRetries = 3) {
  for (let attempt = 0; attempt < maxRetries; attempt++) {
    const { sha, state } = await readCloudState();
    const updated = await mutatorFn(state);
    const res = await writeCloudState(updated, sha, message);

    if (res.status === 200 || res.status === 201) {
      return updated;
    }

    // 409 Conflict / 422 SHA mismatch の場合は少し待ってリトライ
    if (res.status === 409 || res.status === 422) {
      await new Promise(r => setTimeout(r, 300 * (attempt + 1)));
      continue;
    }

    throw new Error(`GitHub API write failed (${res.status}): ${JSON.stringify(res.data)}`);
  }
  throw new Error('Failed to mutate cloud state after maximum retries due to conflicts.');
}

module.exports = {
  readCloudState,
  writeCloudState,
  mutateCloudState,
  getNowJST,
  getTodayYMDJST
};
