/**
 * GENGRAV Database Connection - Supabase PostgreSQL
 * Direct connection to the IRF QR Tracking database
 */
const { Pool } = require('pg');

// Supabase PostgreSQL connection configuration
const DB_CONFIG = {
  user: 'postgres.aktfgilmfoprdkwkzybd',
  password: 'Alqawwiy@123',
  host: 'aws-1-ap-northeast-2.pooler.supabase.com',
  port: 6543,
  database: 'postgres',
  ssl: {
    rejectUnauthorized: false  // Required for Supabase
  },
  // Connection pool settings
  max: 5,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 10000,
};

let pool = null;

/**
 * Run fn(client) on a pooled connection and ALWAYS release it, retrying once on
 * transient connection failures (Supabase pooler drops idle connections).
 */
async function withClient(fn) {
  let lastErr;
  for (let attempt = 0; attempt < 2; attempt++) {
    let client;
    try {
      client = await initPool().connect();
      return await fn(client);
    } catch (error) {
      lastErr = error;
      const transient = /terminat|ECONNRESET|ETIMEDOUT|timeout|Connection|EPIPE/i.test(error.message || '');
      if (!transient) throw error;
    } finally {
      if (client) client.release();
    }
  }
  throw lastErr;
}

/**
 * Initialize the database connection pool
 */
function initPool() {
  if (!pool) {
    pool = new Pool(DB_CONFIG);
    
    pool.on('error', (err) => {
      console.error('Database pool error:', err);
    });
  }
  return pool;
}

/**
 * Test the database connection
 * @returns {Promise<{success: boolean, message?: string, error?: string}>}
 */
async function testConnection() {
  try {
    const result = await withClient(client =>
      client.query('SELECT NOW() as current_time, current_database() as database'));

    const { current_time, database } = result.rows[0];
    console.log(`Database connected: ${database} at ${current_time}`);

    return {
      success: true,
      message: `Connected to ${database}`,
      timestamp: current_time
    };
  } catch (error) {
    console.error('Database connection failed:', error.message);
    return {
      success: false,
      error: error.message
    };
  }
}

/**
 * Fetch items from the database with QR information
 * @param {number} limit - Maximum number of items to fetch
 * @returns {Promise<{success: boolean, items?: Array, error?: string}>}
 */
async function fetchItems(limit = 50) {
  try {
    const result = await withClient(client => client.query(`
      SELECT
        uid,
        component_type,
        lot_number,
        vendor_id,
        quantity,
        current_status,
        qr_image_url,
        created_at,
        updated_at
      FROM items
      ORDER BY created_at DESC
      LIMIT $1
    `, [limit]));

    console.log(`Fetched ${result.rows.length} items from database`);
    return { success: true, items: result.rows };
  } catch (error) {
    console.error('Error fetching items:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Fetch a single item by UID
 * @param {string} uid - The unique identifier of the item
 * @returns {Promise<{success: boolean, item?: object, error?: string}>}
 */
async function fetchItemByUid(uid) {
  try {
    const result = await withClient(client => client.query(`
      SELECT
        uid,
        component_type,
        lot_number,
        vendor_id,
        quantity,
        current_status,
        qr_image_url,
        created_at,
        updated_at
      FROM items
      WHERE uid = $1
    `, [uid]));

    if (result.rows.length === 0) {
      return { success: false, error: 'Item not found' };
    }
    return { success: true, item: result.rows[0] };
  } catch (error) {
    console.error('Error fetching item:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Fetch items pending engraving, oldest first so batches are processed in a
 * stable, predictable order.
 * @param {number} limit - Exact maximum number of items to fetch
 * @returns {Promise<{success: boolean, items?: Array, error?: string}>}
 */
async function fetchPendingEngravings(limit = 50) {
  try {
    const n = Math.max(1, Math.min(10000, parseInt(limit, 10) || 1));
    const result = await withClient(client => client.query(`
      SELECT
        uid,
        component_type,
        lot_number,
        vendor_id,
        quantity,
        current_status,
        qr_image_url,
        created_at
      FROM items
      WHERE current_status IN ('pending', 'registered', 'manufactured')
      ORDER BY created_at ASC, uid ASC
      LIMIT $1
    `, [n]));

    console.log(`Fetched ${result.rows.length} items pending engraving`);
    return { success: true, items: result.rows };
  } catch (error) {
    console.error('Error fetching pending engravings:', error.message);
    return { success: false, error: error.message };
  }
}

/** How many items are waiting to be engraved. */
async function countPendingEngravings() {
  try {
    const result = await withClient(client => client.query(
      `SELECT COUNT(*)::int AS n FROM items WHERE current_status IN ('pending', 'registered', 'manufactured')`));
    return { success: true, count: result.rows[0].n };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

/**
 * Update item status after engraving
 * @param {string} uid - The unique identifier of the item
 * @param {string} status - New status (e.g., 'engraved')
 * @returns {Promise<{success: boolean, error?: string}>}
 */
async function updateItemStatus(uid, status) {
  try {
    const result = await withClient(client => client.query(`
      UPDATE items
      SET current_status = $1, updated_at = NOW()
      WHERE uid = $2
      RETURNING uid, current_status
    `, [status, uid]));

    if (result.rows.length === 0) {
      return { success: false, error: 'Item not found' };
    }
    console.log(`Updated item ${uid} status to: ${status}`);
    return { success: true, item: result.rows[0] };
  } catch (error) {
    console.error('Error updating item status:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Record an engraving job in the database
 * @param {object} engravingData - Engraving job details
 * @returns {Promise<{success: boolean, engraving?: object, error?: string}>}
 */
async function recordEngraving(engravingData) {
  try {
    const { item_uid, operator_id, machine_id, settings, status, job_id, error } = engravingData;
    const jobId = job_id || `gengrav-${Date.now()}-${String(item_uid || '').slice(0, 12)}`;
    const payload = {
      operator_id: operator_id || 'gengrav-operator',
      machine_id: machine_id || 'gengrav-laser-1',
      settings: settings || {},
      error: error || null,
    };

    const result = await withClient(client => client.query(`
      INSERT INTO engravings (job_id, item_uid, status, raw_payload, orphan, created_at, updated_at)
      VALUES ($1, $2, $3, $4, FALSE, NOW(), NOW())
      RETURNING *
    `, [jobId, item_uid, status || 'completed', JSON.stringify(payload)]));

    console.log(`Recorded engraving for item: ${item_uid}`);
    return { success: true, engraving: result.rows[0] };
  } catch (error) {
    console.error('Error recording engraving:', error.message);
    return { success: false, error: error.message };
  }
}

/**
 * Close the database connection pool
 */
async function closePool() {
  if (pool) {
    await pool.end();
    pool = null;
    console.log('Database pool closed');
  }
}

module.exports = {
  initPool,
  testConnection,
  fetchItems,
  fetchItemByUid,
  fetchPendingEngravings,
  countPendingEngravings,
  updateItemStatus,
  recordEngraving,
  closePool
};
