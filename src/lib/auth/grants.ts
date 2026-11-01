import {randomUUID} from 'node:crypto';
import {DatabaseSync} from 'node:sqlite';
import type {Pool} from 'pg';

export type AuthDatabase = DatabaseSync | Pool;
export type Grant = {grantId:string; ownerId:string; clientId:string; sessionId:string; userId:string; clientName:string; createdAt:number};

/** The Better Auth session belongs to one connection, never to the browser session. */
export class GrantStore {
  constructor(private database:AuthDatabase) {}
  async add(ownerId:string,clientId:string,sessionId:string,userId:string,clientName:string,ownerStillValid:()=>Promise<boolean>):Promise<Grant|null> {
    const grant={grantId:randomUUID(),ownerId,clientId,sessionId,userId,clientName,createdAt:Date.now()};
    if(this.database instanceof DatabaseSync) {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        if(!await ownerStillValid()){this.database.exec('COMMIT');return null;}
        this.database.prepare('INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES (?,?,?,?,?,?,?)').run(grant.grantId,ownerId,clientId,sessionId,userId,clientName,grant.createdAt);
        this.database.exec('COMMIT');return grant;
      }catch(error){this.database.exec('ROLLBACK');throw error;}
    }
    const c=await this.database.connect();
    try {
      await c.query('BEGIN');await c.query('SELECT id FROM auth_guard WHERE id=1 FOR UPDATE');
      if(!await ownerStillValid()){await c.query('COMMIT');return null;}
      await c.query('INSERT INTO mcp_grants(id,owner,client_id,session_id,user_id,client_name,created_at) VALUES ($1,$2,$3,$4,$5,$6,$7)',[grant.grantId,ownerId,clientId,sessionId,userId,clientName,grant.createdAt]);
      await c.query('COMMIT');return grant;
    }catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;}finally{c.release();}
  }
  async activeId(grantId:string,ownerId:string):Promise<boolean> {
    if(this.database instanceof DatabaseSync)return !!this.database.prepare(`SELECT 1 FROM mcp_grants g JOIN "session" s ON s.id=g.session_id AND s."userId"=g.user_id WHERE g.id=? AND g.owner=? AND g.revoked_at IS NULL AND s."expiresAt">?`).get(grantId,ownerId,Date.now());
    return !!(await this.database.query(`SELECT 1 FROM mcp_grants g JOIN "session" s ON s.id=g.session_id AND s."userId"=g.user_id WHERE g.id=$1 AND g.owner=$2 AND g.revoked_at IS NULL AND s."expiresAt">now()`,[grantId,ownerId])).rowCount;
  }
  async active(sessionId:string,userId:string,clientId:string):Promise<Grant|null> {
    if(this.database instanceof DatabaseSync) return (this.database.prepare(`SELECT g.id AS grantId,g.owner AS ownerId,g.client_id AS clientId,g.session_id AS sessionId,g.user_id AS userId,g.client_name AS clientName,g.created_at AS createdAt FROM mcp_grants g JOIN "session" s ON s.id=g.session_id AND s."userId"=g.user_id WHERE g.session_id=? AND g.user_id=? AND g.client_id=? AND g.revoked_at IS NULL AND s."expiresAt">?`).get(sessionId,userId,clientId,Date.now()) as Grant|undefined)??null;
    return (await this.database.query(`SELECT g.id AS "grantId",g.owner AS "ownerId",g.client_id AS "clientId",g.session_id AS "sessionId",g.user_id AS "userId",g.client_name AS "clientName",g.created_at AS "createdAt" FROM mcp_grants g JOIN "session" s ON s.id=g.session_id AND s."userId"=g.user_id WHERE g.session_id=$1 AND g.user_id=$2 AND g.client_id=$3 AND g.revoked_at IS NULL AND s."expiresAt">now()`,[sessionId,userId,clientId])).rows[0]??null;
  }
  async list(ownerId:string):Promise<Grant[]> {
    if(this.database instanceof DatabaseSync) return this.database.prepare(`SELECT id AS grantId,owner AS ownerId,client_id AS clientId,session_id AS sessionId,user_id AS userId,client_name AS clientName,created_at AS createdAt FROM mcp_grants WHERE owner=? AND revoked_at IS NULL ORDER BY created_at DESC`).all(ownerId) as Grant[];
    return (await this.database.query(`SELECT id AS "grantId",owner AS "ownerId",client_id AS "clientId",session_id AS "sessionId",user_id AS "userId",client_name AS "clientName",created_at AS "createdAt" FROM mcp_grants WHERE owner=$1 AND revoked_at IS NULL ORDER BY created_at DESC`,[ownerId])).rows;
  }
  async revoke(ownerId:string,grantId:string):Promise<boolean> {
    if(this.database instanceof DatabaseSync) {
      this.database.exec('BEGIN IMMEDIATE');
      try {
        const row=this.database.prepare('SELECT session_id FROM mcp_grants WHERE id=? AND owner=? AND revoked_at IS NULL').get(grantId,ownerId) as {session_id:string}|undefined;
        if(!row){this.database.exec('COMMIT');return false;}
        // Deleting a session nulls refresh.sessionId. Revoke refresh rows first.
        this.database.prepare('UPDATE "oauthRefreshToken" SET revoked=? WHERE "sessionId"=? AND revoked IS NULL').run(Date.now(),row.session_id);
        this.database.prepare('UPDATE mcp_grants SET revoked_at=? WHERE id=?').run(Date.now(),grantId);
        this.database.prepare('DELETE FROM "session" WHERE id=?').run(row.session_id);
        this.database.exec('COMMIT');return true;
      } catch(error){this.database.exec('ROLLBACK');throw error;}
    }
    const c=await this.database.connect();
    try {
      await c.query('BEGIN');const row=(await c.query('SELECT session_id FROM mcp_grants WHERE id=$1 AND owner=$2 AND revoked_at IS NULL FOR UPDATE',[grantId,ownerId])).rows[0];
      if(!row){await c.query('COMMIT');return false;}
      await c.query('UPDATE "oauthRefreshToken" SET revoked=now() WHERE "sessionId"=$1 AND revoked IS NULL',[row.session_id]);
      await c.query('UPDATE mcp_grants SET revoked_at=$1 WHERE id=$2',[Date.now(),grantId]);
      await c.query('DELETE FROM "session" WHERE id=$1',[row.session_id]);await c.query('COMMIT');return true;
    } catch(error){await c.query('ROLLBACK').catch(()=>{});throw error;} finally {c.release();}
  }
}
