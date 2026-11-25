// Vercel Serverless Function: Cloud Sync API for HouseClean Hub
const { readCloudState, mutateCloudState, getNowJST } = require('./_github-db');

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Sync-Pin');
}

module.exports = async (req, res) => {
  setCorsHeaders(res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  // オプションPIN認証チェック
  const requiredPin = process.env.SYNC_PIN;
  if (requiredPin) {
    const providedPin = req.headers['x-sync-pin'] || req.query?.pin;
    if (providedPin !== requiredPin) {
      return res.status(401).json({ error: 'Unauthorized: Invalid Sync PIN' });
    }
  }

  try {
    // 1. 最新データ取得 (GET)
    if (req.method === 'GET') {
      const { state } = await readCloudState();
      return res.status(200).json({
        ok: true,
        state: {
          updatedAt: state.updatedAt,
          projects: state.projects || [],
          deletedProjectIds: state.deletedProjectIds || [],
          contractors: state.contractors || null,
          orderSheetConfig: state.orderSheetConfig || null,
          lineLogs: state.lineLogs || []
        }
      });
    }

    // 2. データ同期・保存 (POST)
    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const clientProjects = Array.isArray(body.projects) ? body.projects : null;
      const clientDeletedIds = Array.isArray(body.deletedProjectIds) ? body.deletedProjectIds : [];

      const updatedState = await mutateCloudState((cloudState) => {
        const deletedSet = new Set([
          ...(cloudState.deletedProjectIds || []),
          ...clientDeletedIds
        ]);

        if (clientProjects !== null) {
          const clientMap = new Map();
          clientProjects.forEach(p => {
            if (p && p.id && !deletedSet.has(p.id)) {
              clientMap.set(p.id, p);
            }
          });

          // サーバー側にだけ存在する（＝LINE Botから直前に自動追加された未同期の）案件を保護マージ
          const mergedProjects = [...clientMap.values()];
          (cloudState.projects || []).forEach(sp => {
            if (sp && sp.id && !clientMap.has(sp.id) && !deletedSet.has(sp.id)) {
              // LINE受信案件などを先頭側に保護追加
              mergedProjects.unshift(sp);
            }
          });

          cloudState.projects = mergedProjects;
        }

        cloudState.deletedProjectIds = Array.from(deletedSet).slice(-200);

        if (body.contractors && typeof body.contractors === 'object') {
          cloudState.contractors = body.contractors;
        }
        if (body.orderSheetConfig && typeof body.orderSheetConfig === 'object') {
          cloudState.orderSheetConfig = body.orderSheetConfig;
        }

        return cloudState;
      }, 'Sync state from HouseClean Hub Web App');

      return res.status(200).json({
        ok: true,
        updatedAt: updatedState.updatedAt,
        projectsCount: (updatedState.projects || []).length,
        state: {
          updatedAt: updatedState.updatedAt,
          projects: updatedState.projects || [],
          deletedProjectIds: updatedState.deletedProjectIds || [],
          contractors: updatedState.contractors || null,
          orderSheetConfig: updatedState.orderSheetConfig || null,
          lineLogs: updatedState.lineLogs || []
        }
      });
    }

    return res.status(405).json({ error: 'Method Not Allowed' });
  } catch (err) {
    console.error('Sync API error:', err);
    return res.status(500).json({ ok: false, error: err.message });
  }
};
