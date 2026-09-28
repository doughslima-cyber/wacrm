// Shared connection helper for the Phase 0 spike scripts.
import pg from 'pg'
import { Connector } from '@google-cloud/cloud-sql-connector'
import { OAuth2Client } from 'google-auth-library'

export async function openDb() {
  let auth
  if (process.env.GOOGLE_OAUTH_ACCESS_TOKEN) {
    auth = new OAuth2Client()
    auth.setCredentials({ access_token: process.env.GOOGLE_OAUTH_ACCESS_TOKEN })
  }
  const connector = new Connector({ auth })
  const opts = await connector.getOptions({
    instanceConnectionName: process.env.INSTANCE_CONNECTION_NAME,
    ipType: 'PUBLIC',
  })
  const client = new pg.Client({
    ...opts,
    user: 'postgres',
    password: process.env.PGPASSWORD,
    database: process.env.DB_NAME || 'wacrm',
  })
  await client.connect()
  return {
    client,
    async close() {
      await client.end()
      connector.close()
    },
  }
}
