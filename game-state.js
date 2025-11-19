const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
};

export class GameStateRoom {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.roomStatePromise = null;
    }

    async fetch(request) {
        if (request.method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        const url = new URL(request.url);
        const roomId = url.searchParams.get('roomId');

        if (!roomId) {
            return this.json({ error: 'roomId is required' }, 400);
        }

        if (request.method === 'GET') {
            const snapshot = await this.getState();
            if (!snapshot) {
                return this.json({ error: 'Room not found' }, 404);
            }
            return this.json(snapshot);
        }

        if (request.method === 'POST') {
            const body = await request.json();
            const updated = await this.state.blockConcurrencyWhile(() =>
                this.applyUpdate(roomId, body)
            );
            return this.json(updated);
        }

        if (request.method === 'DELETE') {
            await this.state.blockConcurrencyWhile(async () => {
                await this.state.storage.deleteAll();
                this.roomStatePromise = Promise.resolve(null);
            });
            return this.json({ success: true });
        }

        return this.json({ error: 'Method not allowed' }, 405);
    }

    async alarm() {
        await this.state.storage.deleteAll();
        this.roomStatePromise = Promise.resolve(null);
    }

    async applyUpdate(roomId, update) {
        const state = await this.ensureState(roomId);
        const now = Date.now();

        if (update.playerId && update.score !== undefined) {
            state.scores[update.playerId] = update.score;
            state.playerWords[update.playerId] = update.words || [];
            state.lastUpdate = now;
        }

        if (update.action === 'start_game') {
            state.gameStarted = true;
            state.startTime = update.startTime || now;
            state.timeLeft = update.timeLeft ?? 180;
            state.consonants = update.consonants || state.consonants || [];
            state.endTime = null;
            state.roundNumber += 1;
            await this.state.storage.deleteAlarm();
        }

        if (update.action === 'new_game') {
            state.gameStarted = true;
            state.startTime = now;
            state.timeLeft = 180;
            state.consonants = update.consonants || [];
            state.endTime = null;
            state.scores = {};
            state.playerWords = {};
            state.roundNumber += 1;
            await this.state.storage.deleteAlarm();
        }

        if (update.action === 'end_game') {
            state.gameStarted = false;
            state.endTime = now;
            await this.state.storage.setAlarm(now + 60 * 1000);
        }

        await this.persistState(state);
        return state;
    }

    async ensureState(roomId) {
        let snapshot = await this.getState();
        if (!snapshot) {
            snapshot = {
                id: roomId,
                createdAt: Date.now(),
                gameStarted: false,
                startTime: null,
                endTime: null,
                timeLeft: 180,
                consonants: [],
                scores: {},
                playerWords: {},
                roundNumber: 0,
                lastUpdate: null
            };
            await this.persistState(snapshot);
        }
        return snapshot;
    }

    async getState() {
        if (!this.roomStatePromise) {
            this.roomStatePromise = this.state.storage.get('roomState');
        }
        return this.roomStatePromise;
    }

    async persistState(state) {
        this.roomStatePromise = Promise.resolve(state);
        await this.state.storage.put('roomState', state);
    }

    json(payload, status = 200) {
        return new Response(JSON.stringify(payload), {
            status,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}

export async function onRequest(context) {
    if (context.request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(context.request.url);
    const roomId = url.searchParams.get('roomId');

    if (!roomId) {
        return new Response(JSON.stringify({ error: 'roomId is required' }), {
            status: 400,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }

    if (!context.env.GAME_STATE) {
        return new Response(JSON.stringify({ error: 'Durable Object binding GAME_STATE missing' }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }

    const id = context.env.GAME_STATE.idFromName(roomId);
    const stub = context.env.GAME_STATE.get(id);

    return stub.fetch(context.request);
}
