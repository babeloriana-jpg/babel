// Vocabulary App - Cloudflare Worker
// Handles all API requests for the vocabulary learning app

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);
    const path = url.pathname;

    try {
      // GET /api/words - pobierz wszystkie słówka
      if (path === '/api/words' && request.method === 'GET') {
        const category = url.searchParams.get('category');
        const data = await env.VOCABULARY_DB.get('words');
        let words = data ? JSON.parse(data) : [];
        if (category && category !== 'all') {
          words = words.filter(w => w.category === category);
        }
        return json(words);
      }

      // POST /api/words - dodaj nowe słówko
      if (path === '/api/words' && request.method === 'POST') {
        const body = await request.json();
        const data = await env.VOCABULARY_DB.get('words');
        const words = data ? JSON.parse(data) : [];

        const newWord = {
          id: Date.now().toString(),
          term: body.term,
          translation: body.translation,
          context: body.context || '',
          category: body.category || 'Angielski',
          createdAt: new Date().toISOString(),
          // SM-2 algorithm fields
          interval: 1,        // days until next review
          repetitions: 0,     // number of successful reviews
          easeFactor: 2.5,    // difficulty multiplier
          nextReview: new Date().toISOString(), // due today
          lastReview: null,
        };

        words.push(newWord);
        await env.VOCABULARY_DB.put('words', JSON.stringify(words));
        return json(newWord, 201);
      }

      // PUT /api/words/:id/review - zaktualizuj po powtórce (SM-2)
      if (path.match(/^\/api\/words\/(.+)\/review$/) && request.method === 'PUT') {
        const id = path.match(/^\/api\/words\/(.+)\/review$/)[1];
        const body = await request.json();
        const quality = body.quality; // 0-5 (0=całkowita porażka, 5=idealna odpowiedź)

        const data = await env.VOCABULARY_DB.get('words');
        const words = data ? JSON.parse(data) : [];
        const wordIndex = words.findIndex(w => w.id === id);

        if (wordIndex === -1) return new Response('Not found', { status: 404 });

        const word = words[wordIndex];
        const updated = applySM2(word, quality);
        words[wordIndex] = updated;

        await env.VOCABULARY_DB.put('words', JSON.stringify(words));
        return json(updated);
      }

      // DELETE /api/words/:id - usuń słówko
      if (path.match(/^\/api\/words\/(.+)$/) && request.method === 'DELETE') {
        const id = path.match(/^\/api\/words\/(.+)$/)[1];
        const data = await env.VOCABULARY_DB.get('words');
        const words = data ? JSON.parse(data) : [];
        const filtered = words.filter(w => w.id !== id);
        await env.VOCABULARY_DB.put('words', JSON.stringify(filtered));
        return json({ success: true });
      }

      // GET /api/due - słówka do powtórki dziś
      if (path === '/api/due' && request.method === 'GET') {
        const category = url.searchParams.get('category');
        const data = await env.VOCABULARY_DB.get('words');
        let words = data ? JSON.parse(data) : [];
        const now = new Date();

        if (category && category !== 'all') {
          words = words.filter(w => w.category === category);
        }

        const due = words.filter(w => new Date(w.nextReview) <= now);
        // Sortuj: najpierw trudniejsze (niższy easeFactor), potem nowe
        due.sort((a, b) => a.easeFactor - b.easeFactor);
        return json(due);
      }

      // GET /api/stats - statystyki
      if (path === '/api/stats' && request.method === 'GET') {
        const data = await env.VOCABULARY_DB.get('words');
        const words = data ? JSON.parse(data) : [];
        const now = new Date();

        const stats = {
          total: words.length,
          due: words.filter(w => new Date(w.nextReview) <= now).length,
          byCategory: {},
          difficult: words.filter(w => w.easeFactor < 2.0 && w.repetitions > 0).length,
        };

        words.forEach(w => {
          if (!stats.byCategory[w.category]) {
            stats.byCategory[w.category] = { total: 0, due: 0 };
          }
          stats.byCategory[w.category].total++;
          if (new Date(w.nextReview) <= now) {
            stats.byCategory[w.category].due++;
          }
        });

        return json(stats);
      }

      return new Response('Not found', { status: 404, headers: CORS_HEADERS });

    } catch (err) {
      return new Response(JSON.stringify({ error: err.message }), {
        status: 500,
        headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
      });
    }
  },
};

// SM-2 Algorithm implementation
function applySM2(word, quality) {
  let { interval, repetitions, easeFactor } = word;

  if (quality >= 3) {
    // Poprawna odpowiedź
    if (repetitions === 0) interval = 1;
    else if (repetitions === 1) interval = 6;
    else interval = Math.round(interval * easeFactor);

    repetitions += 1;
  } else {
    // Błędna odpowiedź - zacznij od nowa
    repetitions = 0;
    interval = 1;
  }

  // Aktualizuj współczynnik trudności
  easeFactor = easeFactor + (0.1 - (5 - quality) * (0.08 + (5 - quality) * 0.02));
  if (easeFactor < 1.3) easeFactor = 1.3;

  const nextReview = new Date();
  nextReview.setDate(nextReview.getDate() + interval);

  return {
    ...word,
    interval,
    repetitions,
    easeFactor,
    nextReview: nextReview.toISOString(),
    lastReview: new Date().toISOString(),
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  });
}
