interface ParticipantInfo {
    registrant_id?: string
    username: string
    email: string // this is not the user's actual email, it's the auto-assigned email
    roomId: string
}

export const ACTIVE_PARTICIPANTS = new Map<string, ParticipantInfo[]>()

// Maps meeting ID to bot ID
export const ACTIVE_BOTS = new Map<string, string>()

/** Email addresses of all host accounts */
export const ZOOM_HOSTS: string[] = [
    "pearprogram-zoom1@proton.me",
    // "pearprogram.zoom2@proton.me"
]

// Values correspond to the order of `ZOOM_HOSTS`.
// Initially, all accounts are available.
export let ACTIVE_MEETINGS: (string | null)[] = ZOOM_HOSTS.map(_ => null)