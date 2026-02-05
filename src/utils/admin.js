import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ADMINS_FILE = path.join(__dirname, '..', '..', 'data', 'admins.json');

// Creator's JID (hardcoded as per requirements)
const CREATOR_JID = '8801316655254@s.whatsapp.net';

/**
 * Ensure the data directory and admins.json file exist
 * Called internally - no need to export
 */
async function ensureAdminsFile() {
    try {
        const dataDir = path.dirname(ADMINS_FILE);
        
        // Create data directory if it doesn't exist
        await fs.mkdir(dataDir, { recursive: true });
        
        // Check if admins.json exists
        try {
            await fs.access(ADMINS_FILE);
        } catch {
            // File doesn't exist, create it with empty admins array
            const initialData = { admins: [] };
            await fs.writeFile(ADMINS_FILE, JSON.stringify(initialData, null, 2));
            console.log(`[ADMIN] Created new admins.json at ${ADMINS_FILE}`);
        }
    } catch (error) {
        console.warn(`[ADMIN] Warning: Could not ensure admins file: ${error.message}`);
    }
}

/**
 * Read admins from file (with error handling)
 * @returns {Promise<string[]>} Array of admin JIDs
 */
async function readAdminsFromFile() {
    try {
        await ensureAdminsFile();
        
        const data = await fs.readFile(ADMINS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        
        // Validate structure
        if (!parsed || !Array.isArray(parsed.admins)) {
            console.warn(`[ADMIN] Invalid admins.json structure, resetting to empty array`);
            return [];
        }
        
        return parsed.admins;
    } catch (error) {
        console.warn(`[ADMIN] Could not read admins.json: ${error.message}. Using empty admin list.`);
        return [];
    }
}

/**
 * Write admins to file
 * @param {string[]} admins - Array of admin JIDs
 */
async function writeAdminsToFile(admins) {
    try {
        const data = { admins };
        await fs.writeFile(ADMINS_FILE, JSON.stringify(data, null, 2));
    } catch (error) {
        console.error(`[ADMIN] Failed to write admins.json: ${error.message}`);
        throw error; // Let caller handle this
    }
}

/**
 * Check if a JID belongs to the creator
 * @param {string} jid - The WhatsApp JID
 * @returns {boolean}
 */
export function isCreator(jid) {
    return jid === CREATOR_JID;
}

/**
 * Check if a JID is an admin (creator is automatically admin)
 * Reads file every time for fresh data
 * @param {string} jid - The WhatsApp JID
 * @returns {Promise<boolean>}
 */
export async function isAdmin(jid) {
    if (!jid) return false;
    
    // Creator is always admin
    if (isCreator(jid)) return true;
    
    const admins = await readAdminsFromFile();
    return admins.includes(jid);
}

/**
 * Promote a user to admin (creator only)
 * @param {string} promoterJid - JID of the person trying to promote
 * @param {string} targetJid - JID to promote
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function promoteAdmin(promoterJid, targetJid) {
    // Only creator can promote
    if (!isCreator(promoterJid)) {
        return { 
            success: false, 
            message: 'Only the creator can promote admins' 
        };
    }
    
    if (!targetJid || !targetJid.includes('@s.whatsapp.net')) {
        return { 
            success: false, 
            message: 'Invalid JID format' 
        };
    }
    
    // Can't promote creator (already admin)
    if (isCreator(targetJid)) {
        return { 
            success: false, 
            message: 'Creator is already admin' 
        };
    }
    
    try {
        const admins = await readAdminsFromFile();
        
        // Check if already admin
        if (admins.includes(targetJid)) {
            return { 
                success: false, 
                message: 'User is already an admin' 
            };
        }
        
        // Add to admins
        admins.push(targetJid);
        await writeAdminsToFile(admins);
        
        console.log(`[ADMIN] ${targetJid} promoted to admin by ${promoterJid}`);
        
        return { 
            success: true, 
            message: 'User promoted to admin successfully' 
        };
    } catch (error) {
        console.error(`[ADMIN] Promotion failed: ${error.message}`);
        return { 
            success: false, 
            message: 'Failed to promote user' 
        };
    }
}

/**
 * Demote a user from admin (creator only)
 * @param {string} demoterJid - JID of the person trying to demote
 * @param {string} targetJid - JID to demote
 * @returns {Promise<{success: boolean, message: string}>}
 */
export async function demoteAdmin(demoterJid, targetJid) {
    // Only creator can demote
    if (!isCreator(demoterJid)) {
        return { 
            success: false, 
            message: 'Only the creator can demote admins' 
        };
    }
    
    if (!targetJid || !targetJid.includes('@s.whatsapp.net')) {
        return { 
            success: false, 
            message: 'Invalid JID format' 
        };
    }
    
    // Can't demote creator
    if (isCreator(targetJid)) {
        return { 
            success: false, 
            message: 'Cannot demote the creator' 
        };
    }
    
    try {
        const admins = await readAdminsFromFile();
        
        // Check if not admin
        if (!admins.includes(targetJid)) {
            return { 
                success: false, 
                message: 'User is not an admin' 
            };
        }
        
        // Remove from admins
        const newAdmins = admins.filter(jid => jid !== targetJid);
        await writeAdminsToFile(newAdmins);
        
        console.log(`[ADMIN] ${targetJid} demoted from admin by ${demoterJid}`);
        
        return { 
            success: true, 
            message: 'User demoted from admin successfully' 
        };
    } catch (error) {
        console.error(`[ADMIN] Demotion failed: ${error.message}`);
        return { 
            success: false, 
            message: 'Failed to demote user' 
        };
    }
}

/**
 * Get list of all admins (excluding creator for brevity, or include with note)
 * @returns {Promise<{creator: string, admins: string[]}>}
 */
export async function getAdminList() {
    const admins = await readAdminsFromFile();
    return {
        creator: CREATOR_JID,
        admins: admins
    };
}

/**
 * Initialize admin system - called on bot startup
 */
export async function initAdminSystem() {
    await ensureAdminsFile();
    const admins = await readAdminsFromFile();
    console.log(`[ADMIN] Admin system initialized. Creator: ${CREATOR_JID}, Additional admins: ${admins.length}`);
}