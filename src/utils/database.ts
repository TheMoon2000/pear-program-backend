import { connect } from 'http2';
import { createPool, PoolConnection, PoolOptions } from 'mysql2/promise';

// mysql configuration
const loginConfig: PoolOptions = {
    connectionLimit: 50,
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    multipleStatements: true,
    connectTimeout: 30000,
    port: 3306
};

let pool = createPool(loginConfig);

/**
 * 
 * @returns {Promise<PoolConnection>}
 */
export async function getConnection(): Promise<PoolConnection> {
    let isReleased = false
    const connection = await pool.getConnection();
    // console.log("created connection", connection.threadId, "at", new Date())
    const originalReleaseFunc = connection.release.bind(connection)
    connection.release = () => {
        connection.release = originalReleaseFunc
        originalReleaseFunc()
        isReleased = true
        // console.log("Released connection", connection.threadId)
    }
    setTimeout(() => {
        if (!isReleased) {
            connection.release = originalReleaseFunc
            connection.release()
            console.warn(`WARNING: force-released connection ${connection.threadId} after 20s`)
        }
    }, 20000)
    return connection
}

/**
 * 
 * @param conn 
 * @param query 
 * @param values 
 * @returns Promise<any>
 */
export async function makeQuery(conn: PoolConnection, query: string, values?: Array<any>): Promise<any> {
    return await conn.query(query, values);
}
