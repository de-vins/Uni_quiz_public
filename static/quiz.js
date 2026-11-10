// -----------------------------
// Swipe + keyboard navigation
// -----------------------------
let __swipeInitDone = false;
function initSwipeNavigationOnce() {
    if (__swipeInitDone) return;
    __swipeInitDone = true;

    const getCard = () => document.querySelector(".question-card");

    let startX = 0, startY = 0;
    let tracking = false;
    let didSwipe = false;

    const isInteractiveTarget = (t) => {
        if (!t) return false;
        return (
            t.closest("button") ||
            t.closest("a") ||
            t.closest("input") ||
            t.closest("select") ||
            t.closest("textarea") ||
            t.closest(".answer-list") ||
            t.closest(".sidebar")
        );
    };

    const trigger = (dir) => {
        if (didSwipe) return;
        didSwipe = true;

        const card = getCard();
        if (card) {
            card.classList.remove("slide-left", "slide-right");
            void card.offsetWidth;
            card.classList.add(dir === "left" ? "slide-left" : "slide-right");
        }

        setTimeout(() => {
            if (card) card.classList.remove("slide-left", "slide-right");
            if (dir === "left") nextQuestion();
            else prevQuestion();
            setTimeout(() => { didSwipe = false; }, 250);
        }, 150);
    };

    // Pointer swipe (replaced by FLUID_SWIPE_PATCH_V1)

    // Keyboard arrows (desktop)
    document.addEventListener("keydown", (e) => {
        const tag = (document.activeElement && document.activeElement.tagName)
            ? document.activeElement.tagName.toLowerCase()
            : "";
        if (tag === "input" || tag === "textarea" || tag === "select") return;

        const openModal = Array.from(document.querySelectorAll(".modal")).some(
            (modal) => modal.style.display !== "none"
        );
        if (openModal) return;

        if (e.key === "ArrowRight") {
            e.preventDefault();
            nextQuestion();
        } else if (e.key === "ArrowLeft") {
            e.preventDefault();
            prevQuestion();
        }
    });
}

// -----------------------------
// Safe HTML rendering (allow only a few tags like <sup>/<sub>)
// -----------------------------
function safeQuizHTML(input) {
    if (input === null || input === undefined) return "";
    // Convert newlines to <br/> for display consistency
    const html = String(input).replace(/\r\n|\r|\n/g, "<br/>");

    // Parse as HTML, then strip everything except a small allowlist (no attributes)
    const tpl = document.createElement("template");
    tpl.innerHTML = html;

    const ALLOWED = new Set(["SUP", "SUB", "BR", "B", "STRONG", "I", "EM", "U", "CODE", "PRE"]);

    (function sanitize(node) {
        const children = Array.from(node.childNodes);
        for (const child of children) {
            if (child.nodeType === Node.ELEMENT_NODE) {
                if (!ALLOWED.has(child.tagName)) {
                    // Replace disallowed elements with their plain text
                    const text = document.createTextNode(child.textContent || "");
                    child.replaceWith(text);
                    continue;
                }
                // Strip all attributes from allowed tags (prevents onclick, styles, etc.)
                if (child.attributes && child.attributes.length) {
                    Array.from(child.attributes).forEach(a => child.removeAttribute(a.name));
                }
                sanitize(child);
            } else if (child.nodeType === Node.TEXT_NODE) {
                // ok
            } else {
                // Remove comments/other node types
                child.remove();
            }
        }
    })(tpl.content);

    // template.innerHTML is supported; otherwise serialize via a wrapper
    return tpl.innerHTML || (() => {
        const wrap = document.createElement("div");
        wrap.appendChild(tpl.content.cloneNode(true));
        return wrap.innerHTML;
    })();
}



/* =========================
   INSTAGRAM_CAROUSEL_SWIPE_V1
   (horizontal drag like Instagram post carousel)
   - NO prefetch / NO caching
   - 1 gesture = +/-1 question max
   - Uses Pointer Events when available, with touch fallback
   - Does NOT touch existing logic (calls nextQuestion/prevQuestion)
   ========================= */
(function () {
    let bound = false;
    let navLocked = false;

    const lockNav = (ms = 520) => {
        navLocked = true;
        setTimeout(() => (navLocked = false), ms);
    };

    const isInteractiveTarget = (t) => {
        if (!t) return false;
        return !!(
            t.closest("button") ||
            t.closest("a") ||
            t.closest("input") ||
            t.closest("select") ||
            t.closest("textarea") ||
            t.closest("label") ||
            t.closest(".answer-list li")
        );
    };

    const bindSwipe = () => {
        if (bound) return;
        const card = document.querySelector(".question-card");
        if (!card) return;

        bound = true;

        // Make animation smooth
        card.style.willChange = "transform";
        card.style.touchAction = "pan-y"; // allow vertical scroll, we manage horizontal

        let dragging = false;
        let startX = 0, startY = 0;
        let lastX = 0, lastT = 0;
        let dx = 0, dy = 0;
        let lockedAxis = null; // "x"|"y"|null
        let raf = 0;
        let didNav = false;

        const width = () => Math.max(1, card.getBoundingClientRect().width);

        const setTx = (x) => {
            // schedule transform update
            dx = x;
            if (raf) return;
            raf = requestAnimationFrame(() => {
                raf = 0;
                card.style.transform = `translateX(${dx}px)`;
            });
        };

        const reset = () => {
            card.style.transition = "transform 220ms ease";
            card.style.transform = "translateX(0px)";
            setTimeout(() => {
                card.style.transition = "";
                card.style.transform = "translateX(0px)";
            }, 240);
        };

        const fly = (dir) => {
            // dir: -1 left (next), +1 right (prev)
            card.style.transition = "transform 190ms ease";
            const off = dir * (width() + 40);
            card.style.transform = `translateX(${off}px)`;
        };

        const navOnce = (dir) => {
            if (navLocked || didNav) return;
            didNav = true;
            lockNav();

            if (dir === "next") {
                if (typeof nextQuestion === "function") nextQuestion();
            } else {
                if (typeof prevQuestion === "function") prevQuestion();
            }

            // snap back ready for new content
            setTimeout(() => {
                card.style.transition = "";
                card.style.transform = "translateX(0px)";
            }, 30);
        };

        const onStart = (x, y, target) => {
            // ignore if user interacts with buttons/answers etc
            if (isInteractiveTarget(target)) return;

            dragging = true;
            didNav = false;
            lockedAxis = null;

            startX = lastX = x;
            startY = y;
            dx = dy = 0;
            lastT = performance.now();

            card.style.transition = "";
        };

        const onMove = (x, y) => {
            if (!dragging) return;

            const mx = x - startX;
            const my = y - startY;

            // axis lock after small threshold
            if (!lockedAxis) {
                if (Math.abs(mx) < 6 && Math.abs(my) < 6) return;
                lockedAxis = Math.abs(mx) >= Math.abs(my) ? "x" : "y";
            }
            if (lockedAxis === "y") {
                // let scroll happen
                dragging = false;
                reset();
                return;
            }

            // horizontal drag: apply slight resistance near edges
            const w = width();
            const clamp = w * 0.85;
            let tx = mx;
            if (tx > clamp) tx = clamp + (tx - clamp) * 0.25;
            if (tx < -clamp) tx = -clamp + (tx + clamp) * 0.25;

            setTx(tx);

            lastX = x;
            lastT = performance.now();
        };

        const onEnd = (x, y) => {
            if (!dragging) return;
            dragging = false;

            const totalDx = x - startX;
            const totalDy = y - startY;

            // if we never locked X, treat as tap
            if (lockedAxis !== "x") {
                reset();
                return;
            }

            const w = width();
            const threshold = Math.max(54, w * 0.18);

            // velocity
            const now = performance.now();
            const dt = Math.max(1, now - lastT);
            const vx = (x - lastX) / dt; // px/ms

            const goNext = (totalDx < -threshold) || (vx < -0.55 && totalDx < -20);
            const goPrev = (totalDx > threshold) || (vx > 0.55 && totalDx > 20);

            if (goNext) {
                fly(-1);
                setTimeout(() => navOnce("next"), 150);
            } else if (goPrev) {
                fly(+1);
                setTimeout(() => navOnce("prev"), 150);
            } else {
                reset();
            }
        };

        // Pointer Events
        if ("PointerEvent" in window) {
            card.addEventListener("pointerdown", (e) => {
                if (e.pointerType === "mouse" && e.button !== 0) return;
                onStart(e.clientX, e.clientY, e.target);
            }, { passive: true });

            card.addEventListener("pointermove", (e) => {
                onMove(e.clientX, e.clientY);
            }, { passive: false });

            const ender = (e) => onEnd(e.clientX, e.clientY);
            card.addEventListener("pointerup", ender, { passive: true });
            card.addEventListener("pointercancel", ender, { passive: true });
        } else {
            // Touch fallback
            card.addEventListener("touchstart", (e) => {
                const t = e.touches && e.touches[0];
                if (!t) return;
                onStart(t.clientX, t.clientY, e.target);
            }, { passive: true });

            card.addEventListener("touchmove", (e) => {
                const t = e.touches && e.touches[0];
                if (!t) return;
                // prevent horizontal scroll while swiping
                if (lockedAxis === "x") e.preventDefault();
                onMove(t.clientX, t.clientY);
            }, { passive: false });

            card.addEventListener("touchend", (e) => {
                const t = e.changedTouches && e.changedTouches[0];
                if (!t) return;
                onEnd(t.clientX, t.clientY);
            }, { passive: true });

            card.addEventListener("touchcancel", (e) => {
                const t = e.changedTouches && e.changedTouches[0];
                if (!t) return;
                onEnd(t.clientX, t.clientY);
            }, { passive: true });
        }
    };

    window.addEventListener("DOMContentLoaded", () => {
        // delay a tick so the DOM is fully laid out
        setTimeout(bindSwipe, 0);
    });
})()


// -------------------------
// USER MENU + CAMBIO PASSWORD
// -------------------------

function scorePassword(pw) {
    let score = 0;
    if (!pw) return { score: 0, label: "-" };
    const len = pw.length;
    const hasLower = /[a-z]/.test(pw);
    const hasUpper = /[A-Z]/.test(pw);
    const hasDigit = /\d/.test(pw);
    const hasSpecial = /[^A-Za-z0-9]/.test(pw);
    const variety = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;

    if (len >= 8) score += 1;
    if (len >= 12) score += 1;
    if (len >= 16) score += 1;
    if (variety >= 2) score += 1;
    if (variety >= 3) score += 1;
    if (variety >= 4) score += 1;

    score = Math.min(score, 5);
    const labels = ["Molto debole", "Debole", "Ok", "Buona", "Forte", "Molto forte"];
    return { score, label: labels[score] };
}

function updateStrengthChange() {
    const input = document.getElementById("newPassword");
    const bar = document.getElementById("pwBarChange");
    const lab = document.getElementById("pwLabelChange");
    if (!input || !bar || !lab) return;
    const { score, label } = scorePassword(input.value);
    bar.style.width = `${(score / 5) * 100}%`;
    lab.textContent = `Forza: ${label}`;
    bar.classList.remove("s0","s1","s2","s3","s4","s5");
    bar.classList.add(`s${score}`);
}

let changePwReturnFocus = null;

function openChangePwModal() {
    const modal = document.getElementById("changePwModal");
    if (!modal) return;
    changePwReturnFocus = document.activeElement;
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    const msg = document.getElementById("changePwMsg");
    if (msg) msg.textContent = "";
    ["currentPassword","newPassword","newPassword2"].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = "";
    });
    updateStrengthChange();
    document.getElementById("currentPassword")?.focus();
}

function closeChangePwModal() {
    const modal = document.getElementById("changePwModal");
    if (!modal) return;
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    changePwReturnFocus?.focus?.();
}

async function submitChangePassword() {
    const msg = document.getElementById("changePwMsg");
    const current = document.getElementById("currentPassword")?.value || "";
    const pw1 = document.getElementById("newPassword")?.value || "";
    const pw2 = document.getElementById("newPassword2")?.value || "";

    if (msg) msg.textContent = "";

    try {
        await safeFetchJson("/api/change_password", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                current_password: current,
                new_password: pw1,
                new_password2: pw2
            })
        });
    } catch (error) {
        if (msg) msg.textContent = error.message || "Errore";
        return;
    }
    if (msg) msg.textContent = "Password aggiornata ✅";
    setTimeout(closeChangePwModal, 900);
}

function initUserMenu() {
    const btn = document.getElementById("userMenuBtn");
    const dd = document.getElementById("userMenuDropdown");
    if (!btn || !dd) return;

    btn.addEventListener("click", (e) => {
        // click desktop

        e.stopPropagation();
        dd.style.display = (dd.style.display === "none" || !dd.style.display) ? "block" : "none";
    });

    dd.addEventListener("click", (e) => e.stopPropagation());

    document.addEventListener("click", () => {
        dd.style.display = "none";
    });

    const openBtn = document.getElementById("changePwOpen");
    const closeBtn = document.getElementById("changePwClose");
    const submitBtn = document.getElementById("changePwSubmit");

    if (openBtn) openBtn.addEventListener("click", () => {
        dd.style.display = "none";
        openChangePwModal();
    });
    if (closeBtn) closeBtn.addEventListener("click", closeChangePwModal);
    if (submitBtn) submitBtn.addEventListener("click", submitChangePassword);

    const modal = document.getElementById("changePwModal");
    if (modal) {
        modal.addEventListener("click", (e) => {
            if (e.target === modal) closeChangePwModal();
        });
        modal.addEventListener("keydown", (e) => {
            if (e.key === "Escape") {
                e.preventDefault();
                closeChangePwModal();
            }
        });
    }

    // occhietto password (toggle) + icona FontAwesome
document.addEventListener("click", (e) => {
    const btn = e.target.closest(".pw-eye");
    if (!btn) return;

    const id = btn.getAttribute("data-target");
    const input = document.getElementById(id);
    if (!input) return;

    const hidden = input.type === "password";
    input.type = hidden ? "text" : "password";

    const icon = btn.querySelector("i");
    if (icon) {
        // visibile -> occhio aperto; nascosta -> occhio sbarrato
        icon.classList.toggle("fa-eye", hidden);
        icon.classList.toggle("fa-eye-slash", !hidden);
    }
});

    const newPw = document.getElementById("newPassword");
    if (newPw) newPw.addEventListener("input", updateStrengthChange);
}

// -------------------------
// RICERCA DOMANDE / RISPOSTE
// -------------------------

let searchReturnFocus = null;
let searchRequestId = 0;
let searchDbKey = null;

function closeSearchModal({ restoreFocus = true } = {}) {
    const modal = document.getElementById("searchModal");
    if (!modal) return;
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    if (restoreFocus) searchReturnFocus?.focus?.();
}

function openSearchModal() {
    const dbKey = document.getElementById("dbSelect")?.value;
    if (!dbKey) {
        showToast("Seleziona prima una materia.");
        return;
    }

    const modal = document.getElementById("searchModal");
    const input = document.getElementById("searchInput");
    const results = document.getElementById("searchResults");
    const status = document.getElementById("searchStatus");
    if (!modal || !input || !results || !status) return;

    searchReturnFocus = document.activeElement;
    if (searchDbKey !== dbKey) {
        input.value = "";
        results.innerHTML = "";
        status.textContent = "Inserisci almeno due caratteri. Puoi usare più parole.";
        searchDbKey = dbKey;
    }
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    input.focus();
}

async function openSearchResult(questionId) {
    closeSearchModal({ restoreFocus: false });
    const canOpen = await requestModeChange("training");
    if (!canOpen) return;
    const startInput = document.getElementById("startingQuestion");
    if (startInput) startInput.value = String(questionId);
    await withCardLoader(startTrainingMode, "Apro la domanda…");
    document.querySelector(".question-card")?.scrollIntoView({
        behavior: "smooth",
        block: "start"
    });
}

function renderSearchResults(data) {
    const results = document.getElementById("searchResults");
    const status = document.getElementById("searchStatus");
    if (!results || !status) return;
    results.innerHTML = "";

    const items = Array.isArray(data?.results) ? data.results : [];
    if (!items.length) {
        status.textContent = "Nessuna domanda trovata.";
        const empty = document.createElement("div");
        empty.className = "search-empty";
        empty.textContent = "Prova con parole più brevi o con un solo concetto.";
        results.appendChild(empty);
        return;
    }

    status.textContent = data.limited
        ? `${data.total} risultati · mostro i primi ${items.length}`
        : `${data.total} ${data.total === 1 ? "risultato" : "risultati"}`;

    items.forEach((item) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "search-result-card";
        button.setAttribute("aria-label", `Apri la domanda ${item.id}`);

        const top = document.createElement("span");
        top.className = "search-result-top";

        const id = document.createElement("span");
        id.className = "search-result-id";
        id.textContent = `ID ${item.id}`;
        top.appendChild(id);

        if (item.has_image) {
            const imageBadge = document.createElement("span");
            imageBadge.className = "search-result-image";
            imageBadge.textContent = "Contiene immagine";
            top.appendChild(imageBadge);
        }

        const question = document.createElement("span");
        question.className = "search-result-question";
        question.textContent = item.testo?.trim() || "Domanda senza testo";

        button.appendChild(top);
        button.appendChild(question);

        const answerMatches = Array.isArray(item.answer_matches)
            ? item.answer_matches.filter((answer) => answer.testo?.trim())
            : [];
        if (answerMatches.length) {
            const matches = document.createElement("span");
            matches.className = "search-result-matches";
            const label = document.createElement("strong");
            label.textContent = "Nelle risposte: ";
            matches.appendChild(label);
            matches.appendChild(document.createTextNode(
                answerMatches.map((answer) => answer.testo.trim()).join(" · ")
            ));
            button.appendChild(matches);
        }

        const openLabel = document.createElement("span");
        openLabel.className = "search-result-open";
        openLabel.innerHTML = 'Apri domanda <span aria-hidden="true">→</span>';
        button.appendChild(openLabel);

        button.addEventListener("click", () => {
            void openSearchResult(Number(item.id));
        });
        results.appendChild(button);
    });
}

async function performQuestionSearch() {
    const input = document.getElementById("searchInput");
    const submit = document.getElementById("searchSubmitBtn");
    const results = document.getElementById("searchResults");
    const status = document.getElementById("searchStatus");
    if (!input || !submit || !results || !status) return;

    const query = input.value.trim();
    if (query.length < 2) {
        status.textContent = "Inserisci almeno due caratteri.";
        input.focus();
        return;
    }

    const requestId = ++searchRequestId;
    submit.disabled = true;
    input.setAttribute("aria-busy", "true");
    status.textContent = "Ricerca in corso…";
    results.innerHTML = '<div class="search-loading" aria-hidden="true"><span></span><span></span><span></span></div>';

    try {
        const data = await safeFetchJson(
            `/api/search_questions?q=${encodeURIComponent(query)}&limit=40`
        );
        if (requestId === searchRequestId) renderSearchResults(data);
    } catch (error) {
        if (requestId === searchRequestId) {
            results.innerHTML = "";
            status.textContent = error.message || "Errore durante la ricerca.";
        }
    } finally {
        if (requestId === searchRequestId) {
            submit.disabled = false;
            input.removeAttribute("aria-busy");
        }
    }
}

function initQuestionSearch() {
    const modal = document.getElementById("searchModal");
    const openButton = document.getElementById("searchOpenBtn");
    const closeButton = document.getElementById("searchCloseBtn");
    const submitButton = document.getElementById("searchSubmitBtn");
    const input = document.getElementById("searchInput");
    if (!modal || !openButton || !closeButton || !submitButton || !input) return;

    openButton.addEventListener("click", openSearchModal);
    closeButton.addEventListener("click", () => closeSearchModal());
    submitButton.addEventListener("click", () => void performQuestionSearch());
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            void performQuestionSearch();
        }
    });
    modal.addEventListener("click", (event) => {
        if (event.target === modal) closeSearchModal();
    });
    modal.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
            event.preventDefault();
            closeSearchModal();
        }
    });
}

// --- STATI GLOBALI ---
let correctCount = 0;
let incorrectCount = 0;
let answeredCount = 0;

let currentQuestionIndex = 1;   // allenamento
let savedQuestions = [];
let savedIdSet = new Set();
let isSavedQuiz = false;
let activeListQuizKind = null;
let activeListQuizLabel = "domande salvate";
let trainingQuestionCache = new Map();
let selectedDatabaseKey = null;
let latestReviewStats = {
    tracked: 0,
    errors: 0,
    consolidate: 0,
    strengths: 0
};
let reviewStatsRefreshTimer = null;

let hasAnsweredCurrent = false; // evita doppi conteggi in allenamento

const REVIEW_CATEGORIES = {
    errors: {
        label: "errori frequenti",
        empty: "Non hai ancora errori registrati in questa materia."
    },
    consolidate: {
        label: "domande da consolidare",
        empty: "Servono risposte sia corrette sia errate per creare questa categoria."
    },
    strengths: {
        label: "punti forti",
        empty: "Non ci sono ancora risposte corrette registrate."
    }
};

function updateActiveReviewProgress() {
    const wrapper = document.getElementById("activeReviewProgress");
    const label = document.getElementById("activeReviewLabel");
    const position = document.getElementById("activeReviewPosition");
    const fill = document.getElementById("activeReviewFill");
    const track = wrapper?.querySelector(".active-review-track");
    if (!wrapper || !label || !position || !fill) return;

    const visible =
        mode === "training" &&
        isSavedQuiz &&
        activeListQuizKind === "review" &&
        Array.isArray(savedQuestions) &&
        savedQuestions.length > 0;
    if (!visible) {
        wrapper.style.display = "none";
        fill.style.width = "0%";
        if (track) track.setAttribute("aria-valuenow", "0");
        return;
    }

    const total = savedQuestions.length;
    const current = Math.min(total, Math.max(1, currentQuestionIndex + 1));
    const percentage = Math.round((current / total) * 100);
    label.textContent = activeListQuizLabel;
    position.textContent = `${current}/${total}`;
    position.setAttribute(
        "aria-label",
        `Domanda ${current} di ${total}`
    );
    fill.style.width = `${percentage}%`;
    if (track) {
        track.setAttribute("aria-valuenow", String(percentage));
        track.setAttribute(
            "aria-label",
            `${activeListQuizLabel}: domanda ${current} di ${total}`
        );
    }
    wrapper.style.display = "block";
}

function updateReviewStatsUI(stats = {}) {
    latestReviewStats = {
        tracked: Number(stats.tracked || 0),
        errors: Number(stats.errors || 0),
        consolidate: Number(stats.consolidate || 0),
        strengths: Number(stats.strengths || 0)
    };

    const bindings = {
        errors: "reviewErrorsCount",
        consolidate: "reviewConsolidateCount",
        strengths: "reviewStrengthsCount"
    };
    Object.entries(bindings).forEach(([category, id]) => {
        const count = latestReviewStats[category];
        const countEl = document.getElementById(id);
        if (countEl) countEl.textContent = String(count);
        const button = document.querySelector(`[data-review-category="${category}"]`);
        if (button) {
            button.disabled = quizBusy || count <= 0;
            button.setAttribute(
                "aria-label",
                `${REVIEW_CATEGORIES[category].label}: ${count} ${count === 1 ? "domanda" : "domande"}`
            );
        }
    });

    const status = document.getElementById("reviewHistoryStatus");
    if (status) {
        status.textContent = latestReviewStats.tracked
            ? `${latestReviewStats.tracked} ${latestReviewStats.tracked === 1 ? "domanda registrata" : "domande registrate"} · gli stati cambiano con i tuoi progressi.`
            : "Inizia a rispondere: le categorie si creeranno e aggiorneranno automaticamente.";
    }
}

async function refreshReviewStats({ silent = true } = {}) {
    const dbKey = document.getElementById("dbSelect")?.value;
    if (!dbKey) {
        updateReviewStatsUI({});
        return;
    }
    try {
        const stats = await safeFetchJson("/api/review_stats");
        updateReviewStatsUI(stats);
    } catch (error) {
        if (!silent) {
            showToast(error.message || "Impossibile aggiornare il ripasso personale.", "error");
        }
    }
}

function scheduleReviewStatsRefresh() {
    clearTimeout(reviewStatsRefreshTimer);
    reviewStatsRefreshTimer = setTimeout(() => {
        void refreshReviewStats();
    }, 350);
}

async function recordQuestionAttempts(attempts) {
    const dbKey = document.getElementById("dbSelect")?.value;
    if (!dbKey || !Array.isArray(attempts) || !attempts.length) return;
    try {
        const data = await safeFetchJson("/api/question_attempts", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ db_key: dbKey, attempts })
        });
        if (data?.stats) updateReviewStatsUI(data.stats);
        else scheduleReviewStatsRefresh();
    } catch (error) {
        // Il quiz deve restare utilizzabile anche se il salvataggio statistico fallisce.
        console.warn("Statistiche ripasso non salvate:", error);
    }
}

async function startReviewQuiz(category) {
    quizVoice.cancelAutoAdvance();
    const config = REVIEW_CATEGORIES[category];
    if (!config) return;
    if (mode === "exam" && isExamMode) {
        showToast("Consegna o abbandona prima la simulazione in corso.", "error");
        return;
    }

    const canSwitch = await requestModeChange("training");
    if (!canSwitch) return;

    await withCardLoader(async () => {
        let data;
        try {
            data = await safeFetchJson(
                `/api/review_questions?category=${encodeURIComponent(category)}&limit=60`
            );
        } catch (error) {
            showToast(error.message || "Impossibile caricare il ripasso.", "error");
            return;
        }

        const questions = Array.isArray(data?.questions) ? data.questions : [];
        if (!questions.length) {
            showToast(config.empty);
            await refreshReviewStats();
            return;
        }

        savedQuestions = questions;
        resetSession();
        isSavedQuiz = true;
        activeListQuizKind = "review";
        activeListQuizLabel = config.label;
        currentQuestionIndex = 0;
        hideExamSummary();
        renderExamSidebar();
        updateProgress();
        loadSavedQuestion();
        showNavButtons();
        document.querySelector(".question-card")?.scrollIntoView({
            behavior: "smooth",
            block: "start"
        });
        showToast(`Ripasso avviato: ${questions.length} domande.`, "success");
    }, "Preparo il ripasso personale…");
}

function initPersonalReview() {
    document.querySelectorAll("[data-review-category]").forEach((button) => {
        button.addEventListener("click", () => {
            void startReviewQuiz(button.dataset.reviewCategory);
        });
    });
    updateReviewStatsUI({});
}

async function loadDbOptions() {
    const sel = document.getElementById("dbSelect");
    if (!sel) return;

    const data = await safeFetchJson("/api/databases");

    sel.innerHTML = "";

    // placeholder
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "Seleziona una materia";
    ph.disabled = true;
    ph.selected = true;
    sel.appendChild(ph);

    (data.options || []).forEach((opt) => {
        const o = document.createElement("option");
        o.value = opt.key;       // db_key (relpath)
        o.textContent = opt.label; // nome materia
        sel.appendChild(o);
    });

    // se c'è una materia già attiva, selezionala
    if (data.active) {
        sel.value = data.active;
        selectedDatabaseKey = data.active;
    }
}

async function setDatabase(dbKey) {
    if (isExamMode && !examFinished && examQuestions.length) {
        const { answered, total } = getExamAnswerCounts();
        const changeDatabase = await askForConfirmation({
            title: "Cambiare materia?",
            message: "La simulazione in corso verrà abbandonata.",
            detail: `Hai risposto a ${answered} domande su ${total}.`,
            confirmLabel: "Cambia materia",
            cancelLabel: "Continua il test",
            danger: true
        });
        if (!changeDatabase) {
            const select = document.getElementById("dbSelect");
            if (select && selectedDatabaseKey) select.value = selectedDatabaseKey;
            return false;
        }
    }

    quizVoice.cancelAutoAdvance();
    try {
        await safeFetchJson("/api/set_database", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ db_key: dbKey })
        });
    } catch (error) {
        showToast(error.message || "Errore nel cambio materia", "error");
        const select = document.getElementById("dbSelect");
        if (select && selectedDatabaseKey) select.value = selectedDatabaseKey;
        return false;
    }
    selectedDatabaseKey = dbKey;

    // reset UI locale (per evitare incongruenze con domande salvate del db precedente)
    closeSearchModal({ restoreFocus: false });
    searchDbKey = null;
    resetSession();
    savedQuestions = [];
    savedIdSet = new Set();
    activeListQuizKind = null;
    trainingQuestionCache.clear();
    updateSavedCount(0);
    updateReviewStatsUI({});
    updateActiveReviewProgress();

    // torna a stato iniziale
    mode = "training";
    setMode("training");

    // nascondo nav
    const nextBtn = document.getElementById("nextBtn");
    const prevBtn = document.getElementById("prevBtn");
    if (nextBtn) nextBtn.style.display = "none";
    if (prevBtn) prevBtn.style.display = "none";

    // pulizia card
    const domandaIdEl = document.getElementById("domanda-id");
    const domandaText = document.getElementById("domanda");
    const answersList = document.getElementById("risposte");
    const resultEl = document.getElementById("result");
    if (domandaIdEl) domandaIdEl.innerText = "ID Domanda: -";
    if (domandaText) domandaText.innerText = "Seleziona modalità e premi Inizia.";
    if (answersList) answersList.innerHTML = "";
    if (resultEl) resultEl.innerText = "";

    await fetchQuestionsCount();
    await refreshSavedState();
    await refreshReviewStats();
// pre-carica info fonti/pool per la simulazione
try {
    const rInfo = await fetch(`/api/database_info?db_key=${encodeURIComponent(dbKey)}`, { credentials: "same-origin", cache: "no-store" });
    const jInfo = await rInfo.json();
    window.__DB_SOURCES__ = Array.isArray(jInfo.sources) ? jInfo.sources : [];
} catch (e) {
    window.__DB_SOURCES__ = [];
}
    return true;
}


// modalità: 'training' | 'exam'

// --------- CARD LOADER (Material 3 + Skeleton) ---------
function showCardLoader(text = "Carico la domanda…") {
    const overlay = document.getElementById("cardLoader");
    const t = document.getElementById("cardLoaderText");
    if (t) t.textContent = text;
    if (overlay) overlay.classList.remove("hidden");
    document.querySelector(".question-card")?.classList.add("loading");
}

function hideCardLoader() {
    const overlay = document.getElementById("cardLoader");
    if (overlay) overlay.classList.add("hidden");
    document.querySelector(".question-card")?.classList.remove("loading");
}

let quizBusy = false;

function setQuizBusy(busy) {
    quizBusy = Boolean(busy);
    ["startButton", "nextBtn", "prevBtn", "startSavedButton", "searchOpenBtn"].forEach((id) => {
        const el = document.getElementById(id);
        if (el) {
            const isNavigationButton = id === "nextBtn" || id === "prevBtn";
            el.disabled = quizBusy || (isNavigationButton && navigationBusy);
        }
    });
    document.querySelectorAll(".mode-tab").forEach((button) => {
        button.disabled = quizBusy;
    });
    updateReviewStatsUI(latestReviewStats);
    const card = document.querySelector(".question-card");
    if (card) card.setAttribute("aria-busy", quizBusy ? "true" : "false");
}

async function withCardLoader(fn, text, delayMs = 140) {
    if (quizBusy) return;
    setQuizBusy(true);
    let shownAt = 0;
    const showTimer = setTimeout(() => {
        shownAt = performance.now();
        showCardLoader(text);
    }, Math.max(0, Number(delayMs) || 0));
    try {
        return await fn();
    } finally {
        clearTimeout(showTimer);
        if (shownAt) {
            const remaining = Math.max(0, 220 - (performance.now() - shownAt));
            if (remaining) {
                await new Promise((resolve) => setTimeout(resolve, remaining));
            }
        }
        hideCardLoader();
        setQuizBusy(false);
    }
}

async function safeFetchJson(url, options = {}, timeoutMs = 12000) {
    const controller = new AbortController();
    const id = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        const raw = await res.text();
        let data = null;
        try {
            data = raw ? JSON.parse(raw) : null;
        } catch (_) {
            data = null;
        }

        if (res.status === 401) {
            const next = encodeURIComponent(window.location.pathname + window.location.search);
            window.location.assign(`/login?next=${next}`);
            throw new Error("Sessione scaduta. Accedi nuovamente.");
        }
        if (!res.ok) {
            throw new Error(data?.error || `Errore HTTP ${res.status}`);
        }
        return data;
    } catch (error) {
        if (error?.name === "AbortError") {
            throw new Error("La richiesta sta impiegando troppo tempo. Riprova.");
        }
        throw error;
    } finally {
        clearTimeout(id);
    }
}

function showToast(message, type = "info") {
    let region = document.getElementById("toastRegion");
    if (!region) {
        region = document.createElement("div");
        region.id = "toastRegion";
        region.className = "toast-region";
        region.setAttribute("aria-live", "polite");
        region.setAttribute("aria-atomic", "true");
        document.body.appendChild(region);
    }

    const toast = document.createElement("div");
    toast.className = `toast toast-${type}`;
    toast.textContent = String(message || "Operazione completata");
    region.appendChild(toast);
    requestAnimationFrame(() => toast.classList.add("show"));
    setTimeout(() => {
        toast.classList.remove("show");
        setTimeout(() => toast.remove(), 180);
    }, 3200);
}

let confirmModalResolver = null;
let confirmModalReturnFocus = null;

function closeConfirmModal(accepted = false) {
    const modal = document.getElementById("confirmModal");
    if (!modal || modal.style.display === "none") return;
    modal.style.display = "none";
    modal.setAttribute("aria-hidden", "true");
    const resolver = confirmModalResolver;
    confirmModalResolver = null;
    confirmModalReturnFocus?.focus?.();
    confirmModalReturnFocus = null;
    if (resolver) resolver(Boolean(accepted));
}

function askForConfirmation({
    title,
    message,
    detail = "",
    confirmLabel = "Conferma",
    cancelLabel = "Annulla",
    danger = false
}) {
    const modal = document.getElementById("confirmModal");
    const titleEl = document.getElementById("confirmModalTitle");
    const messageEl = document.getElementById("confirmModalMessage");
    const detailEl = document.getElementById("confirmModalDetail");
    const acceptBtn = document.getElementById("confirmModalAccept");
    const cancelBtn = document.getElementById("confirmModalCancel");
    if (!modal || !titleEl || !messageEl || !detailEl || !acceptBtn || !cancelBtn) {
        return Promise.resolve(window.confirm(message || title || "Confermare?"));
    }

    if (confirmModalResolver) {
        confirmModalResolver(false);
        confirmModalResolver = null;
    }
    confirmModalReturnFocus = document.activeElement;
    titleEl.textContent = title || "Conferma operazione";
    messageEl.textContent = message || "";
    detailEl.textContent = detail;
    detailEl.style.display = detail ? "block" : "none";
    acceptBtn.textContent = confirmLabel;
    cancelBtn.textContent = cancelLabel;
    acceptBtn.classList.toggle("danger-confirm", danger);
    modal.style.display = "flex";
    modal.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => cancelBtn.focus());

    return new Promise((resolve) => {
        confirmModalResolver = resolve;
    });
}

let mode = "training";
let isExamMode = false;

// dati simulazione
let examQuestions = [];
let examIndex = 0;
let examAnswers = [];
let examFinished = false;

// timer simulazione
let examTimerId = null;
let examTimeRemaining = 0; // secondi
let examStartTimestamp = null;

// --------- UTILITA' BASE ---------

async function fetchQuestionsCount() {
    try {
        const d = await safeFetchJson("/api/questions_count");
        const totalEl = document.getElementById("totalQuestions");
        if (totalEl) totalEl.innerText = (d && d.count != null) ? String(d.count) : "-";
    } catch (e) {
        const totalEl = document.getElementById("totalQuestions");
        if (totalEl) totalEl.innerText = "-";
    }
}

function updateSavedCount(countOverride=null) {
    const savedCountEl = document.getElementById("savedCount");
    if (savedCountEl) {
        const n = (countOverride !== null) ? countOverride : savedIdSet.size;
        savedCountEl.innerText = `Salvate: ${n}`;
    }
}
async function refreshSavedState() {
    try {
        const data = await safeFetchJson("/api/saved_ids");
        const ids = (data && data.ids) ? data.ids : [];
        savedIdSet = new Set(ids.map(Number));
        updateSavedCount(ids.length);
    } catch (e) {
        showToast(e.message || "Impossibile aggiornare le domande salvate", "error");
    }
    updateStarForCurrent();
}

function updateStarForQuestionId(qid) {
    const btn = document.getElementById("saveStar");
    if (!btn) return;
    const isSaved = savedIdSet.has(Number(qid));
    btn.classList.toggle("saved", isSaved);
    btn.setAttribute(
        "aria-label",
        isSaved ? "Rimuovi domanda dalle salvate" : "Salva domanda"
    );
    btn.title = isSaved ? "Rimuovi dalle salvate" : "Salva domanda";
    const icon = btn.querySelector("i");
    if (icon) {
        icon.classList.toggle("fa-solid", isSaved);
        icon.classList.toggle("fa-regular", !isSaved);
        /* keep */
    }
}

function updateStarForCurrent() {
    const domandaIdEl = document.getElementById("domanda-id");
    if (!domandaIdEl) return;
    const m = domandaIdEl.innerText.match(/ID Domanda:\s*(\d+)/);
    if (!m) return;
    updateStarForQuestionId(Number(m[1]));
}


function updateSessionStats() {
    const answeredEl = document.getElementById("answeredCount");
    const accEl = document.getElementById("accuracy");
    const perfEl = document.getElementById("performanceLabel");
    const perfContainer = document.querySelector(".session-item.session-performance");

    if (answeredEl) answeredEl.innerText = answeredCount;

    const total = correctCount + incorrectCount;

    // % di accuratezza (già ti torna utile, la manteniamo)
    let accuracy = 0;
    if (total > 0) {
        accuracy = Math.round((correctCount / total) * 100);
    }
    if (accuracy < 0) accuracy = 0;
    if (accuracy > 100) accuracy = 100;
    if (accEl) accEl.innerText = `${accuracy}%`;

    // voto in 30esimi, arrotondato per difetto
    let score30 = 0;
    if (total > 0) {
        score30 = Math.floor((correctCount / total) * 30);
    }

    // Testo della valutazione (es: 20/30)
    if (perfEl) {
        perfEl.innerText = total === 0 ? "-/30" : `${score30}/30`;
    }

    // Colori in base al voto
    if (perfContainer) {
        perfContainer.classList.remove("perf-bad", "perf-medium", "perf-good");
        if (total > 0) {
            if (score30 < 18) {
                perfContainer.classList.add("perf-bad");      // rosso
            } else if (score30 <= 24) {
                perfContainer.classList.add("perf-medium");   // giallo
            } else {
                perfContainer.classList.add("perf-good");     // verde
            }
        }
    }
}



function resetSession() {
    quizVoice.cancelAutoAdvance();
    correctCount = 0;
    incorrectCount = 0;
    answeredCount = 0;
    hasAnsweredCurrent = false;

    const correctCountEl = document.getElementById("correctCount");
    const incorrectCountEl = document.getElementById("incorrectCount");
    if (correctCountEl) correctCountEl.innerText = "0";
    if (incorrectCountEl) incorrectCountEl.innerText = "0";

    updateSessionStats();

    const resultEl = document.getElementById("result");
    if (resultEl) resultEl.innerText = "";

    document.querySelectorAll(".answer-list li").forEach((li) => {
        li.classList.remove("selected", "correct", "wrong");
        li.setAttribute("aria-pressed", "false");
        li.removeAttribute("aria-disabled");
    });
}

function shuffleArray(array) {
    const out = array.slice();
    for (let i = out.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

function prepareQuestion(question) {
    if (!question || !Array.isArray(question.risposte)) return question;
    return {
        ...question,
        risposte: shuffleArray(question.risposte)
    };
}

function showNavButtons() {
    const nextBtn = document.getElementById("nextBtn");
    const prevBtn = document.getElementById("prevBtn");
    if (nextBtn) nextBtn.style.display = "inline-flex";
    if (prevBtn) prevBtn.style.display = "inline-flex";
    updateExamControls();
}

function hideNavButtons() {
    const nextBtn = document.getElementById("nextBtn");
    const prevBtn = document.getElementById("prevBtn");
    const finishBtn = document.getElementById("finishExamBtn");
    if (nextBtn) nextBtn.style.display = "none";
    if (prevBtn) prevBtn.style.display = "none";
    if (finishBtn) finishBtn.style.display = "none";
}

function getExamAnswerCounts() {
    const answered = examAnswers.filter((answerId) => answerId != null).length;
    return {
        answered,
        unanswered: Math.max(0, examQuestions.length - answered),
        total: examQuestions.length
    };
}

function updateExamControls() {
    const nextBtn = document.getElementById("nextBtn");
    const prevBtn = document.getElementById("prevBtn");
    const finishBtn = document.getElementById("finishExamBtn");
    const activeExam = mode === "exam" && isExamMode && !examFinished && examQuestions.length > 0;

    if (finishBtn) finishBtn.style.display = activeExam ? "inline-flex" : "none";
    if (!activeExam) {
        if (nextBtn) nextBtn.textContent = "Prossima domanda";
        if (!navigationBusy && !quizBusy) {
            if (nextBtn) nextBtn.disabled = false;
            if (prevBtn) prevBtn.disabled = false;
        }
        return;
    }
    if (navigationBusy || quizBusy) return;

    if (prevBtn) prevBtn.disabled = examIndex <= 0;
    if (nextBtn) {
        const isLast = examIndex >= examQuestions.length - 1;
        nextBtn.disabled = isLast;
        nextBtn.textContent = isLast ? "Ultima domanda" : "Prossima domanda";
    }
}

function hideExamSummary() {
    const summary = document.getElementById("examSummary");
    if (summary) {
        summary.style.display = "none";
        summary.innerHTML = "";
    }
}

// progress bar per simulazione
function updateProgress() {
    const wrapper = document.getElementById("progressBarWrapper");
    const label = document.getElementById("progressLabel");
    const fill = document.getElementById("progressFill");
    const bar = wrapper?.querySelector(".progress-bar");
    const answeredEl = document.getElementById("progressAnswered");

    if (!wrapper || !label || !fill) return;

    if (!isExamMode || !examQuestions.length) {
        wrapper.style.display = "none";
        return;
    }

    const current = examIndex + 1;
    const total = examQuestions.length;
    const { answered } = getExamAnswerCounts();
    wrapper.style.display = "block";
    label.innerText = `Domanda ${current}/${total}`;
    if (answeredEl) {
        answeredEl.innerText = `${answered}/${total} ${answered === 1 ? "risposta" : "risposte"}`;
    }
    const perc = Math.round((current / total) * 100);
    fill.style.width = `${perc}%`;
    if (bar) bar.setAttribute("aria-valuenow", String(perc));
}

// sidebar simulazione
function renderExamSidebar() {
    const sidebar = document.getElementById("examSidebar");
    const list = document.getElementById("examQuestionList");
    if (!sidebar || !list) return;

    if (!isExamMode || !examQuestions.length) {
        sidebar.style.display = "none";
        list.innerHTML = "";
        return;
    }

    sidebar.style.display = "block";
    list.innerHTML = "";

    examQuestions.forEach((_, idx) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "sidebar-item";
        btn.innerText = (idx + 1).toString();
        const answered = examAnswers[idx] != null;
        btn.setAttribute(
            "aria-label",
            `Vai alla domanda ${idx + 1}, ${answered ? "risposta" : "senza risposta"}`
        );
        btn.setAttribute("aria-current", idx === examIndex ? "step" : "false");

        if (idx === examIndex) {
            btn.classList.add("current");
        }

        if (answered) {
            btn.classList.add("answered");
        } else {
            btn.classList.add("unanswered");
        }

        btn.onclick = () => {
            examIndex = idx;
            renderExamQuestion();
            document.querySelector(".question-card")?.scrollIntoView({
                behavior: "smooth",
                block: "start"
            });
        };

        list.appendChild(btn);
    });
}

// timer
function stopExamTimer() {
    if (examTimerId) {
        clearInterval(examTimerId);
        examTimerId = null;
    }
    const timerDisplay = document.getElementById("timerDisplay");
    if (timerDisplay) timerDisplay.style.display = "none";
}

function startExamTimer(seconds) {
    stopExamTimer();
    examTimeRemaining = seconds;

    const timerDisplay = document.getElementById("timerDisplay");
    if (!timerDisplay) return;
    timerDisplay.style.display = "inline";

    function update() {
        const m = Math.floor(examTimeRemaining / 60);
        const s = examTimeRemaining % 60;
        const mm = m.toString().padStart(2, "0");
        const ss = s.toString().padStart(2, "0");
        timerDisplay.innerText = `${mm}:${ss}`;

        if (examTimeRemaining <= 0) {
            stopExamTimer();
            if (!examFinished && isExamMode) {
                void requestFinishExam({ timedOut: true });
            }
        } else {
            examTimeRemaining--;
        }
    }

    update();
    examTimerId = setInterval(update, 1000);
}

// animazione card
function applyCardAnimation() {
    const card = document.querySelector(".question-card");
    if (!card) return;
    card.classList.remove("fade-in");
    void card.offsetWidth; // force reflow
    card.classList.add("fade-in");
}

// --------- RENDER DOMANDA GENERICA ---------

function renderQuestionPayload(question, forExam) {
    quizVoice.onQuestionRendered();
    const domandaIdEl = document.getElementById("domanda-id");
    const domandaText = document.getElementById("domanda");
    const answersList = document.getElementById("risposte");
    const resultEl = document.getElementById("result");

    if (domandaIdEl) domandaIdEl.innerText = `ID Domanda: ${question.id}`;
        // Pill fonte (accanto al numero domanda)
    const sourcePill = document.getElementById("sourcePill");
    if (sourcePill) {
        const src = (question && question.source) ? String(question.source).trim() : "";
        if (src) {
            sourcePill.style.display = "inline-flex";
            sourcePill.textContent = src;

            // Tooltip opzionale con nota (read-only) se presente
            const note = (question && question.source_note) ? String(question.source_note).trim() : "";
            sourcePill.title = note ? note : src;
        } else {
            sourcePill.style.display = "none";
            sourcePill.textContent = "";
            sourcePill.title = "";
        }
    }


    if (domandaText) {
        domandaText.innerHTML = "";
        if (question.immagine) {
            const img = document.createElement("img");
            img.src = `data:${question.immagine_mime || "image/jpeg"};base64,${question.immagine}`;
            img.alt = "Immagine della domanda";
            domandaText.appendChild(img);
        }
        if (question.testo) {
            const p = document.createElement("p");
            p.innerHTML = safeQuizHTML(question.testo);
            domandaText.appendChild(p);
        }
    }

    if (answersList) answersList.innerHTML = "";
    if (resultEl) resultEl.innerText = "";

    if (!answersList) return;

    const displayAnswers = Array.isArray(question.risposte) ? question.risposte : [];

    displayAnswers.forEach((risposta, optionIndex) => {
        const li = document.createElement("li");
        const container = document.createElement("div");
        // Le opzioni sono rimescolate: la lettera segue SEMPRE l'ordine a schermo.
        const optionLetter = String.fromCharCode(65 + optionIndex);
        const letter = document.createElement("span");
        letter.className = "voice-option-letter";
        letter.textContent = optionLetter;
        letter.setAttribute("aria-hidden", "true");
        li.classList.add("voice-lettered-answer");
        li.setAttribute("aria-label", `Risposta ${optionLetter}`);
        li.appendChild(letter);

        if (risposta.immagine) {
            const img = document.createElement("img");
            img.src = `data:${risposta.immagine_mime || "image/jpeg"};base64,${risposta.immagine}`;
            img.alt = "Immagine risposta";
            container.appendChild(img);
        }

        if (risposta.testo) {
            const span = document.createElement("span");
            span.innerHTML = safeQuizHTML(risposta.testo);
            container.appendChild(span);
        }

        li.appendChild(container);
        li.dataset.answerId = risposta.id;
        li.tabIndex = 0;
        li.setAttribute("role", "button");
        li.setAttribute("aria-pressed", "false");

        if (forExam) {
            li.onclick = () => selectExamAnswer(li, risposta.id);
        } else {
            li.onclick = () =>
                checkAnswerTraining(li, risposta.id, question.corretta);
        }
        li.addEventListener("keydown", (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                li.click();
            }
        });

        answersList.appendChild(li);
    });

    if (forExam) {
        const selectedId = examAnswers[examIndex];
        if (selectedId != null) {
            const selectedLi = Array.from(answersList.querySelectorAll("li")).find(
                (li) => Number(li.dataset.answerId) === Number(selectedId)
            );
            if (selectedLi) {
                selectedLi.classList.add("selected");
                selectedLi.setAttribute("aria-pressed", "true");
            }
        }
    }

    applyCardAnimation();

    // aggiorna stellina salvata
    updateStarForQuestionId(question.id);
}

// --------- MODALITÀ ALLENAMENTO ---------

async function getTrainingQuestion() {
    let question;
    try {
        let rawQuestion = trainingQuestionCache.get(currentQuestionIndex);
        if (!rawQuestion) {
            rawQuestion = await safeFetchJson(`/api/question/${currentQuestionIndex}`);
            trainingQuestionCache.set(currentQuestionIndex, rawQuestion);
        }
        // In allenamento ogni visualizzazione è un nuovo tentativo:
        // nessuna risposta precedente e nuovo ordine delle opzioni.
        question = prepareQuestion(rawQuestion);
    } catch (err) {
        console.error(err);
        const domandaIdEl = document.getElementById("domanda-id");
        const domandaText = document.getElementById("domanda");
        const answersList = document.getElementById("risposte");
        const resultEl = document.getElementById("result");

        if (domandaIdEl) domandaIdEl.innerText = "ID Domanda: -";
        if (domandaText) domandaText.innerText = "Errore nel caricamento domanda. Riprova.";
        if (answersList) answersList.innerHTML = `<li><button id="retryLoadQ" class="btn-primary">Riprova</button></li>`;
        if (resultEl) resultEl.innerText = "";

        const retryBtn = document.getElementById("retryLoadQ");
        if (retryBtn) retryBtn.onclick = () => withCardLoader(getTrainingQuestion, "Riprovo a caricare…");

        return;
    }

    hasAnsweredCurrent = false;
    hideExamSummary();
    renderExamSidebar();
    updateProgress();
    stopExamTimer();

    if (question.error) {
        const domandaIdEl = document.getElementById("domanda-id");
        const domandaText = document.getElementById("domanda");
        const answersList = document.getElementById("risposte");
        const resultEl = document.getElementById("result");

        if (domandaIdEl) domandaIdEl.innerText = "ID Domanda: -";
        if (domandaText) domandaText.innerText = "Domanda non trovata.";
        if (answersList) answersList.innerHTML = "";
        if (resultEl) resultEl.innerText = "";
        return;
    }

    renderQuestionPayload(question, false);
    showNavButtons();

}

function getRenderedQuestionId() {
    const text = document.getElementById("domanda-id")?.innerText || "";
    const match = text.match(/ID Domanda:\s*(\d+)/);
    return match ? Number(match[1]) : null;
}

function checkAnswerTraining(selectedLi, selectedId, correctId) {
    const result = document.getElementById("result");

    if (hasAnsweredCurrent) {
        return;
    }
    hasAnsweredCurrent = true;

    const allLis = document.querySelectorAll(".answer-list li");
    allLis.forEach((li) => {
        li.classList.remove("selected", "correct", "wrong");
    });

    const isCorrect = Number(selectedId) === Number(correctId);
    answeredCount++;
    if (isCorrect) {
        selectedLi.classList.add("selected", "correct");
        if (result) result.innerText = "Risposta corretta.";
        correctCount++;
    } else {
        selectedLi.classList.add("selected", "wrong");
        if (result) result.innerText = "Risposta errata.";
        incorrectCount++;
    }

    const correctLi = Array.from(allLis).find(
        (li) => Number(li.dataset.answerId) === Number(correctId)
    );
    if (correctLi) {
        correctLi.classList.add("correct");
    }
    allLis.forEach((li) => {
        li.setAttribute("aria-disabled", "true");
        li.setAttribute(
            "aria-pressed",
            Number(li.dataset.answerId) === Number(selectedId) ? "true" : "false"
        );
    });

    const correctCountEl = document.getElementById("correctCount");
    const incorrectCountEl = document.getElementById("incorrectCount");
    if (correctCountEl) correctCountEl.innerText = correctCount;
    if (incorrectCountEl) incorrectCountEl.innerText = incorrectCount;

    updateSessionStats();
    showNavButtons();

    const questionId = getRenderedQuestionId();
    if (questionId) {
        void recordQuestionAttempts([
            { question_id: questionId, correct: isCorrect }
        ]);
    }
    quizVoice.onTrainingAnswered();
}

async function startTrainingMode() {
    mode = "training";
    isExamMode = false;
    isSavedQuiz = false;
    activeListQuizKind = null;
    updateActiveReviewProgress();
    examFinished = false;
    examQuestions = [];
    examAnswers = [];

    hideExamSummary();
    stopExamTimer();

    const startingQuestion =
        document.getElementById("startingQuestion").value || "1";
    currentQuestionIndex = Math.max(1, parseInt(startingQuestion, 10) || 1);

    await getTrainingQuestion();
    showNavButtons();
}

// --------- MODALITÀ SIMULAZIONE ---------



// ===== Pool selector (simulazione) =====
let poolSlidersState = [];
const poolWeightsByDb = new Map();

function showPoolWarning(msg) {
    const el = document.getElementById("poolWarning");
    if (!el) return;
    if (msg && String(msg).trim()) {
        el.textContent = String(msg).trim();
        el.style.display = "block";
    } else {
        el.textContent = "";
        el.style.display = "none";
    }
}

function applyPoolRangeFill(rangeEl) {
    const val = Number(rangeEl.value || 0);
    const pct = Math.max(0, Math.min(100, val));
    const hue = rangeEl.dataset.hue || "210";
    rangeEl.style.background = `linear-gradient(to right,
        hsla(${hue}, 88%, 64%, 0.95) 0%,
        hsla(${hue}, 88%, 64%, 0.95) ${pct}%,
        rgba(255,255,255,0.18) ${pct}%,
        rgba(255,255,255,0.18) 100%)`;
}

function collectPoolWeights() {
    // Raccoglie solo slider visibili e con percentuale > 0
    const section = document.getElementById("poolSection");
    if (!section || section.style.display === "none") return {};
    const weights = {};
    for (const it of poolSlidersState) {
        const v = Number(it.rangeEl.value || 0);
        if (v > 0) weights[it.source] = v;
    }
    return weights;
}

function distributeIntegerTotal(indices, total, weights = null) {
    if (!indices.length) return;
    const sourceWeights = indices.map((idx) => {
        const value = weights ? Number(weights[idx] || 0) : 1;
        return Math.max(0, value);
    });
    let weightSum = sourceWeights.reduce((sum, value) => sum + value, 0);
    if (weightSum <= 0) {
        sourceWeights.fill(1);
        weightSum = sourceWeights.length;
    }

    const raw = sourceWeights.map((value) => (value / weightSum) * total);
    const values = raw.map(Math.floor);
    let remainder = total - values.reduce((sum, value) => sum + value, 0);
    const order = raw
        .map((value, pos) => ({ pos, fraction: value - values[pos] }))
        .sort((a, b) => b.fraction - a.fraction);
    for (let i = 0; i < remainder; i++) {
        values[order[i % order.length].pos] += 1;
    }
    indices.forEach((idx, pos) => {
        poolSlidersState[idx].rangeEl.value = String(values[pos]);
    });
}

function rememberPoolWeights() {
    const dbKey = document.getElementById("dbSelect")?.value;
    if (!dbKey) return;
    const saved = {};
    for (const item of poolSlidersState) {
        saved[item.source] = item.active ? Number(item.rangeEl.value || 0) : 0;
    }
    poolWeightsByDb.set(dbKey, saved);
}

function updatePoolUI() {
    for (const item of poolSlidersState) {
        if (item.active && Number(item.rangeEl.value || 0) <= 0) {
            item.active = false;
        }
    }
    const activeItems = poolSlidersState.filter((item) => item.active);
    for (const item of poolSlidersState) {
        const value = item.active ? Number(item.rangeEl.value || 0) : 0;
        item.rangeEl.value = String(value);
        item.pillEl.textContent = `${value}%`;
        item.card.classList.toggle("active", item.active);
        item.toggleBtn.classList.toggle("active", item.active);
        item.toggleBtn.setAttribute("aria-pressed", item.active ? "true" : "false");
        item.toggleBtn.setAttribute(
            "aria-label",
            `${item.active ? "Escludi" : "Includi"} il pool ${item.source}`
        );
        item.rangeEl.disabled = !item.active || activeItems.length === 1;
        item.onlyBtn.disabled = item.active && activeItems.length === 1;
        applyPoolRangeFill(item.rangeEl);
    }

    const activeCount = document.getElementById("poolActiveCount");
    const totalWeight = document.getElementById("poolTotalWeight");
    const total = activeItems.reduce(
        (sum, item) => sum + Number(item.rangeEl.value || 0),
        0
    );
    if (activeCount) {
        activeCount.textContent = `${activeItems.length} ${activeItems.length === 1 ? "pool attivo" : "pool attivi"}`;
    }
    if (totalWeight) totalWeight.textContent = `${total}%`;
    rememberPoolWeights();
}

function equalizeActivePools() {
    const activeIndices = poolSlidersState
        .map((item, idx) => item.active ? idx : -1)
        .filter((idx) => idx >= 0);
    distributeIntegerTotal(activeIndices, 100);
    updatePoolUI();
}

function rebalancePoolWeights(changedIdx) {
    const activeIndices = poolSlidersState
        .map((item, idx) => item.active ? idx : -1)
        .filter((idx) => idx >= 0);
    if (!activeIndices.length) return;
    if (activeIndices.length === 1) {
        poolSlidersState[activeIndices[0]].rangeEl.value = "100";
        updatePoolUI();
        return;
    }

    const changed = poolSlidersState[changedIdx];
    const changedValue = Math.max(
        0,
        Math.min(100, Math.round(Number(changed.rangeEl.value || 0)))
    );
    if (changedValue <= 0) {
        changed.active = false;
        equalizeActivePools();
        return;
    }
    if (changedValue >= 100) {
        setOnlySource(changedIdx);
        return;
    }
    changed.rangeEl.value = String(changedValue);
    const otherIndices = activeIndices.filter((idx) => idx !== changedIdx);
    const previousWeights = {};
    otherIndices.forEach((idx) => {
        previousWeights[idx] = Number(poolSlidersState[idx].rangeEl.value || 0);
    });
    distributeIntegerTotal(otherIndices, 100 - changedValue, previousWeights);
    updatePoolUI();
}

function setOnlySource(idx) {
    if (!poolSlidersState.length) return;
    for (let i = 0; i < poolSlidersState.length; i++) {
        poolSlidersState[i].active = i === idx;
        poolSlidersState[i].rangeEl.value = i === idx ? "100" : "0";
    }
    updatePoolUI();
}

function togglePool(idx) {
    const item = poolSlidersState[idx];
    if (!item) return;
    const activeCount = poolSlidersState.filter((entry) => entry.active).length;
    if (item.active && activeCount === 1) {
        showToast("Deve rimanere attivo almeno un pool.");
        return;
    }
    item.active = !item.active;
    equalizeActivePools();
}

function hidePoolSection() {
    const section = document.getElementById("poolSection");
    if (section) section.style.display = "none";
    const wrap = document.getElementById("poolSliders");
    if (wrap) wrap.innerHTML = "";
    poolSlidersState = [];
}

function renderPoolSlidersFromDbSources() {
    const section = document.getElementById("poolSection");
    const wrap = document.getElementById("poolSliders");
    if (!section || !wrap) return;

    const sources = Array.isArray(window.__DB_SOURCES__) ? window.__DB_SOURCES__ : [];
    if (!sources || sources.length < 2) {
        // con 0/1 fonte non ha senso mostrare sliders
        section.style.display = "none";
        poolSlidersState = [];
        return;
    }

    section.style.display = "block";
    wrap.innerHTML = "";
    poolSlidersState = [];
    const dbKey = document.getElementById("dbSelect")?.value || "";
    const storedWeights = poolWeightsByDb.get(dbKey);
    const hues = [205, 265, 155, 28, 335, 185, 48, 230];

    sources.forEach((s, idx) => {
        const card = document.createElement("div");
        card.className = "pool-card";
        const hue = hues[idx % hues.length];
        card.style.setProperty("--pool-hue", hue);

        const top = document.createElement("div");
        top.className = "pool-row-top";

        const toggleBtn = document.createElement("button");
        toggleBtn.type = "button";
        toggleBtn.className = "pool-toggle";
        toggleBtn.innerHTML = '<span aria-hidden="true">✓</span>';

        const meta = document.createElement("div");
        meta.className = "pool-meta";

        const name = document.createElement("div");
        name.className = "pool-name";
        name.textContent = s.source || "(senza fonte)";
        name.title = name.textContent;

        const sub = document.createElement("div");
        sub.className = "pool-sub";
        const a = Number(s.from || 0);
        const b = Number(s.to || 0);
        const n = Number(s.count || 0);
        const rangeTxt = (a && b) ? `da ${a} a ${b}` : "";

        const countText = document.createElement("span");
        countText.className = "pool-count";
        countText.textContent = `${n} ${n === 1 ? "domanda" : "domande"}`;
        sub.appendChild(countText);

        if (rangeTxt) {
            const separator = document.createElement("span");
            separator.className = "pool-sub-separator";
            separator.textContent = "·";
            separator.setAttribute("aria-hidden", "true");

            const rangeText = document.createElement("span");
            rangeText.className = "pool-question-range";
            rangeText.textContent = rangeTxt;

            sub.appendChild(separator);
            sub.appendChild(rangeText);
        }
        sub.title = `${n} ${n === 1 ? "domanda" : "domande"}${rangeTxt ? ` · ${rangeTxt}` : ""}`;

        meta.appendChild(name);
        meta.appendChild(sub);

        const actions = document.createElement("div");
        actions.className = "pool-actions";

        const onlyBtn = document.createElement("button");
        onlyBtn.type = "button";
        onlyBtn.className = "pool-only";
        onlyBtn.textContent = "Solo questo";

        const pill = document.createElement("div");
        pill.className = "pool-pill";

        actions.appendChild(onlyBtn);
        actions.appendChild(pill);

        const identity = document.createElement("div");
        identity.className = "pool-identity";
        identity.appendChild(toggleBtn);
        identity.appendChild(meta);
        top.appendChild(identity);
        top.appendChild(actions);

        const bottom = document.createElement("div");
        bottom.className = "pool-row-bottom";

        const range = document.createElement("input");
        range.type = "range";
        range.min = "0";
        range.max = "100";
        range.step = "1";
        const storedValue = storedWeights ? Number(storedWeights[name.textContent] || 0) : null;
        range.value = storedValue != null ? String(storedValue) : "0";
        range.className = "pool-range";
        range.dataset.hue = String(hue);
        range.setAttribute("aria-label", `Peso del pool ${name.textContent}`);

        bottom.appendChild(range);

        let note = null;
        if (s.note) {
            note = document.createElement("div");
            note.className = "pool-note";

            const noteLabel = document.createElement("span");
            noteLabel.className = "pool-note-label";
            noteLabel.textContent = "Fonte";
            note.appendChild(noteLabel);

            const noteText = String(s.note).trim();
            if (/^https?:\/\//i.test(noteText)) {
                const noteLink = document.createElement("a");
                noteLink.className = "pool-note-link";
                noteLink.href = noteText;
                noteLink.target = "_blank";
                noteLink.rel = "noopener noreferrer";
                noteLink.textContent = noteText;
                note.appendChild(noteLink);
            } else {
                const noteContent = document.createElement("span");
                noteContent.className = "pool-note-text";
                noteContent.textContent = noteText;
                note.appendChild(noteContent);
            }
        }

        card.appendChild(top);
        card.appendChild(bottom);
        if (note) card.appendChild(note);
        wrap.appendChild(card);

        const item = {
            source: name.textContent,
            rangeEl: range,
            pillEl: pill,
            onlyBtn,
            toggleBtn,
            card,
            count: n,
            active: storedWeights ? storedValue > 0 : true
        };
        poolSlidersState.push(item);

        range.addEventListener("input", () => {
            const idx2 = poolSlidersState.indexOf(item);
            rebalancePoolWeights(idx2);
        });

        onlyBtn.addEventListener("click", () => {
            const idx2 = poolSlidersState.indexOf(item);
            setOnlySource(idx2);
        });
        toggleBtn.addEventListener("click", () => {
            const idx2 = poolSlidersState.indexOf(item);
            togglePool(idx2);
        });
    });

    const equalizeBtn = document.getElementById("poolEqualizeBtn");
    if (equalizeBtn) equalizeBtn.onclick = equalizeActivePools;

    if (storedWeights && poolSlidersState.some((item) => item.active)) {
        const activeIndices = poolSlidersState
            .map((item, idx) => item.active ? idx : -1)
            .filter((idx) => idx >= 0);
        const currentWeights = {};
        activeIndices.forEach((idx) => {
            currentWeights[idx] = Number(poolSlidersState[idx].rangeEl.value || 0);
        });
        distributeIntegerTotal(activeIndices, 100, currentWeights);
        updatePoolUI();
    } else {
        poolSlidersState.forEach((item) => { item.active = true; });
        equalizeActivePools();
    }
}
async function startExamMode() {
    mode = "exam";
    isExamMode = true;
    isSavedQuiz = false;
    activeListQuizKind = null;
    updateActiveReviewProgress();
    examFinished = false;

    hideExamSummary();
    resetSession();

    examStartTimestamp = Date.now();

    let limit = 30;
    const examInput = document.getElementById("examQuestionCount");
    if (examInput) {
        const parsed = parseInt(examInput.value, 10);
        if (!isNaN(parsed) && parsed > 0) {
            limit = Math.min(parsed, 200);
            examInput.value = String(limit);
        }
    }

// Se esistono pool slider (fonti), uso estrazione pesata
    const weights = collectPoolWeights();
    try {
        if (weights && Object.keys(weights).length > 0) {
            const data = await safeFetchJson("/api/random_questions_weighted", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "same-origin",
                body: JSON.stringify({ limit, weights })
            });
            examQuestions = (data && Array.isArray(data.questions)) ? data.questions : [];
            showPoolWarning(data?.warning ? String(data.warning) : "");
        } else {
            examQuestions = await safeFetchJson(`/api/random_questions?limit=${limit}`);
            showPoolWarning("");
        }
    } catch (error) {
        isExamMode = false;
        showToast(error.message || "Impossibile caricare la simulazione", "error");
        return;
    }

    if (!Array.isArray(examQuestions) || examQuestions.length === 0) {
        showToast("Non è stato possibile caricare le domande casuali.", "error");
        isExamMode = false;
        return;
    }
    examQuestions = examQuestions.map(prepareQuestion);

    examIndex = 0;
    examAnswers = new Array(examQuestions.length).fill(null);

    // timer opzionale
    const timerEnabled = document.getElementById("examTimerEnabled").checked;
    if (timerEnabled) {
        let minutes = parseInt(
            document.getElementById("examTimerMinutes").value,
            10
        );
        if (isNaN(minutes) || minutes <= 0) minutes = 30;
        startExamTimer(minutes * 60);
    } else {
        stopExamTimer();
    }

    renderExamQuestion();
    showNavButtons();
}

function renderExamQuestion() {
    const question = examQuestions[examIndex];
    if (!question) return;

    renderQuestionPayload(question, true);
    renderExamSidebar();
    updateProgress();
    updateExamControls();

    const resultEl = document.getElementById("result");
    if (resultEl) resultEl.innerText = "";

}

function selectExamAnswer(selectedLi, answerId) {
    const allLis = document.querySelectorAll(".answer-list li");
    allLis.forEach((li) => {
        li.classList.remove("selected", "correct", "wrong");
    });

    selectedLi.classList.add("selected");
    selectedLi.setAttribute("aria-pressed", "true");
    allLis.forEach((li) => {
        if (li !== selectedLi) li.setAttribute("aria-pressed", "false");
    });
    examAnswers[examIndex] = answerId;
    renderExamSidebar();
    updateProgress();
    updateExamControls();
}

async function requestFinishExam({ timedOut = false } = {}) {
    if (!isExamMode || examFinished || !examQuestions.length) return false;
    const { answered, unanswered, total } = getExamAnswerCounts();

    if (timedOut) {
        finishExam();
        showToast("Tempo scaduto: la simulazione è stata consegnata.", "info");
        return true;
    }

    const confirmed = await askForConfirmation({
        title: "Consegnare la simulazione?",
        message: unanswered
            ? `Hai risposto a ${answered} domande su ${total}.`
            : `Hai risposto a tutte le ${total} domande.`,
        detail: unanswered
            ? `${unanswered} ${unanswered === 1 ? "domanda è ancora senza risposta" : "domande sono ancora senza risposta"}. Potrai riconoscerle anche nel riepilogo.`
            : "Dopo la consegna vedrai il punteggio e il dettaglio delle risposte.",
        confirmLabel: "Consegna",
        cancelLabel: unanswered ? "Torna alle domande" : "Continua il test"
    });
    if (!confirmed) return false;
    finishExam();
    return true;
}

function updateExamSessionStats(correct, wrong, total) {
    correctCount = correct;
    incorrectCount = Math.max(0, total - correct);
    answeredCount = correct + wrong;

    const correctCountEl = document.getElementById("correctCount");
    const incorrectCountEl = document.getElementById("incorrectCount");
    const answeredEl = document.getElementById("answeredCount");
    const accuracyEl = document.getElementById("accuracy");
    const performanceEl = document.getElementById("performanceLabel");
    const performanceBox = document.querySelector(".session-item.session-performance");
    const score30 = total ? Math.floor((correct / total) * 30) : 0;
    const accuracy = total ? Math.round((correct / total) * 100) : 0;

    if (correctCountEl) correctCountEl.innerText = String(correct);
    if (incorrectCountEl) incorrectCountEl.innerText = String(incorrectCount);
    if (answeredEl) answeredEl.innerText = String(answeredCount);
    if (accuracyEl) accuracyEl.innerText = `${accuracy}%`;
    if (performanceEl) performanceEl.innerText = total ? `${score30}/30` : "-/30";
    if (performanceBox) {
        performanceBox.classList.remove("perf-bad", "perf-medium", "perf-good");
        performanceBox.classList.add(
            score30 < 18 ? "perf-bad" : score30 <= 24 ? "perf-medium" : "perf-good"
        );
    }
}

function finishExam() {
    quizVoice.cancelAutoAdvance();
    isExamMode = false;
    examFinished = true;
    stopExamTimer();
    hideNavButtons();

    let localCorrect = 0;
    let localWrong = 0;
    let localUnanswered = 0;

    const summary = document.getElementById("examSummary");
    if (!summary) return;

    summary.innerHTML = "";
    const title = document.createElement("h2");
    title.textContent = `Riepilogo simulazione (${examQuestions.length} domande)`;
    summary.appendChild(title);

    examQuestions.forEach((q, idx) => {
        const chosenId = examAnswers[idx];
        const correctId = q.corretta;

        const answersMap = {};
        q.risposte.forEach((r) => {
            answersMap[r.id] = r.testo;
        });

        const chosenText =
            chosenId != null ? answersMap[chosenId] || "(non risposto)" : "(non risposto)";
        const correctText = answersMap[correctId] || "";

        const isUnanswered = chosenId == null;
        const isCorrect = !isUnanswered && chosenId === correctId;
        const status = isCorrect ? "correct" : isUnanswered ? "unanswered" : "wrong";

        if (isCorrect) {
            localCorrect++;
        } else if (isUnanswered) {
            localUnanswered++;
        } else {
            localWrong++;
        }

        const item = document.createElement("details");
        item.className = `summary-item ${status}`;
        item.dataset.status = status;

        const itemHeader = document.createElement("summary");
        const qText = document.createElement("span");
        qText.className = "summary-question";
        qText.textContent = `${idx + 1}. ${q.testo}`;
        itemHeader.appendChild(qText);

        const statusBadge = document.createElement("span");
        statusBadge.className = "summary-status";
        statusBadge.textContent = isCorrect ? "Corretta" : isUnanswered ? "Errore · non risposta" : "Errore";
        itemHeader.appendChild(statusBadge);
        item.appendChild(itemHeader);

        const answerDetail = document.createElement("div");
        answerDetail.className = "summary-answer-detail";

        const chosenP = document.createElement("div");
        chosenP.textContent = `Tua risposta: ${chosenText}`;
        answerDetail.appendChild(chosenP);

        const correctP = document.createElement("div");
        correctP.textContent = `Risposta corretta: ${correctText}`;
        answerDetail.appendChild(correctP);
        item.appendChild(answerDetail);

        summary.appendChild(item);
    });

    const total = examQuestions.length;
    let score30 = 0;
    if (total > 0) {
        score30 = Math.floor((localCorrect / total) * 30);
    }

    // tempo impiegato
    let elapsedSec = 0;
    if (examStartTimestamp) {
        elapsedSec = Math.round((Date.now() - examStartTimestamp) / 1000);
    }
    const mm = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
    const ss = String(elapsedSec % 60).padStart(2, "0");

    const overview = document.createElement("div");
    overview.className = "exam-overview";

    if (total > 0) {
        if (score30 < 18) {
            overview.classList.add("perf-bad");
        } else if (score30 <= 24) {
            overview.classList.add("perf-medium");
        } else {
            overview.classList.add("perf-good");
        }
    }

    overview.innerHTML = `
        <div class="exam-score-block">
            <span class="exam-score-label">Punteggio</span>
            <strong class="exam-score-value">${total === 0 ? "-/30" : `${score30}/30`}</strong>
        </div>
        <div class="exam-stat-grid">
            <div><strong>${localCorrect}</strong><span>Corrette</span></div>
            <div><strong>${localWrong + localUnanswered}</strong><span>Errori</span></div>
            <div><strong>${localUnanswered}</strong><span>Non risposte</span></div>
            <div><strong>${mm}:${ss}</strong><span>Tempo</span></div>
        </div>
    `;

    summary.insertBefore(overview, title.nextSibling);

    const filters = document.createElement("div");
    filters.className = "summary-filters";
    filters.setAttribute("aria-label", "Filtra il riepilogo");
    [
        ["all", "Tutte"],
        ["review", `Da rivedere (${localWrong + localUnanswered})`],
        ["correct", `Corrette (${localCorrect})`]
    ].forEach(([filter, label], index) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = `summary-filter${index === 0 ? " active" : ""}`;
        button.textContent = label;
        button.setAttribute("aria-pressed", index === 0 ? "true" : "false");
        button.addEventListener("click", () => {
            filters.querySelectorAll(".summary-filter").forEach((candidate) => {
                const active = candidate === button;
                candidate.classList.toggle("active", active);
                candidate.setAttribute("aria-pressed", active ? "true" : "false");
            });
            summary.querySelectorAll(".summary-item").forEach((row) => {
                const visible =
                    filter === "all" ||
                    (filter === "review" && row.dataset.status !== "correct") ||
                    row.dataset.status === filter;
                row.hidden = !visible;
            });
        });
        filters.appendChild(button);
    });
    overview.insertAdjacentElement("afterend", filters);

    summary.style.display = "block";

    // In simulazione la valutazione usa tutte le domande, incluse le omissioni.
    updateExamSessionStats(localCorrect, localWrong, total);
    void recordQuestionAttempts(
        examQuestions.map((question, index) => ({
            question_id: Number(question.id),
            correct:
                examAnswers[index] != null &&
                Number(examAnswers[index]) === Number(question.corretta)
        }))
    );
    summary.scrollIntoView({ behavior: "smooth" });

    const list = document.getElementById("examQuestionList");
    if (list) {
        const items = list.querySelectorAll(".sidebar-item");
        items.forEach((el, idx) => {
            const chosenId = examAnswers[idx];
            const correctId = examQuestions[idx].corretta;
            el.classList.remove("current", "answered", "unanswered", "wrong");
            if (chosenId === correctId) {
                el.classList.add("answered");
            } else if (chosenId == null) {
                el.classList.add("wrong", "unanswered");
            } else {
                el.classList.add("wrong");
            }
        });
    }
}


// --------- NAVIGAZIONE ---------

async function nextQuestionOriginal() {
    // se la simulazione è finita, resta sul riepilogo (non ripartire in allenamento)
    if (examFinished) {
        const sum = document.getElementById("examSummary");
        if (sum) sum.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
    }

    if (mode === "exam" && isExamMode) {
        if (examIndex < examQuestions.length - 1) {
            examIndex++;
            renderExamQuestion();
        } else if (!examFinished) {
            await requestFinishExam();
        }
        return;
    }

    // allenamento / salvate
    if (isSavedQuiz) {
        if (currentQuestionIndex < savedQuestions.length - 1) {
            currentQuestionIndex++;
            loadSavedQuestion();
        } else {
            showToast(`Hai completato il ripasso: ${activeListQuizLabel}.`, "success");
            return;
        }
    } else {
        currentQuestionIndex++;
        return withCardLoader(
            getTrainingQuestion,
            "Carico la prossima domanda…",
            120
        );
    }
    showNavButtons();
}

async function prevQuestionOriginal() {
    if (examFinished) {
        const sum = document.getElementById("examSummary");
        if (sum) sum.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
    }

    if (mode === "exam" && isExamMode) {
        if (examIndex > 0) {
            examIndex--;
            renderExamQuestion();
        }
        return;
    }

    if (isSavedQuiz) {
        if (currentQuestionIndex > 0) {
            currentQuestionIndex--;
            loadSavedQuestion();
        }
    } else {
        if (currentQuestionIndex > 1) {
            currentQuestionIndex--;
            return withCardLoader(
                getTrainingQuestion,
                "Carico la domanda precedente…",
                120
            );
        }
    }
    showNavButtons();
}

// --------- DOMANDE SALVATE ---------

async function startSavedQuiz() {
    quizVoice.cancelAutoAdvance();
    if (mode === "exam" && isExamMode) {
        showToast("Non puoi usare le domande salvate durante la simulazione.", "error");
        return;
    }

    await withCardLoader(async () => {
        let idData;
        try {
            idData = await safeFetchJson("/api/saved_ids");
        } catch (err) {
            console.error(err);
            showToast(err.message || "Errore nel caricamento delle domande salvate.", "error");
            return;
        }

        const ids = (idData && idData.ids) ? idData.ids : [];
        savedIdSet = new Set(ids.map(Number));
        updateSavedCount(ids.length);

        if (!ids || ids.length === 0) {
            showToast("Nessuna domanda salvata.");
            return;
        }

        // endpoint già usato nel tuo codice originale
        try {
            const questions = await safeFetchJson("/api/questions_by_ids", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ ids })
            });
            savedQuestions = questions;
        } catch (error) {
            showToast(error.message || "Errore nel caricamento delle domande salvate.", "error");
            return;
        }

        resetSession();
        isSavedQuiz = true;
        activeListQuizKind = "saved";
        activeListQuizLabel = "domande salvate";
        currentQuestionIndex = 0;
        hideExamSummary();
        renderExamSidebar();
        updateProgress();
        loadSavedQuestion();
        showNavButtons();
    }, "Carico le domande salvate…");
}

function loadSavedQuestion() {
    const rawQuestion = savedQuestions[currentQuestionIndex];
    if (!rawQuestion) return;

    // Anche nelle salvate, tornando su una domanda si ricomincia da zero
    // e le risposte vengono rimescolate.
    hasAnsweredCurrent = false;
    const question = prepareQuestion(rawQuestion);
    renderQuestionPayload(question, false);
    updateActiveReviewProgress();

    const resultEl = document.getElementById("result");
    if (resultEl) resultEl.innerText = "";
}

async function clearSavedQuestions() {
    try {
        const data = await safeFetchJson("/api/clear_saved_questions", { method: "DELETE" });
        if (activeListQuizKind === "saved") {
            savedQuestions = [];
            isSavedQuiz = false;
            activeListQuizKind = null;
        }
        savedIdSet = new Set();
        updateSavedCount(data?.count ?? 0);
        updateStarForCurrent();
        showToast("Tutte le domande salvate sono state cancellate.", "success");
    } catch (error) {
        showToast(error.message || "Errore durante la cancellazione", "error");
    }
}

// --------- AVVIO E UI ---------

async function startQuiz() {
    quizVoice.cancelAutoAdvance();
    const dbSelect = document.getElementById("dbSelect");
    if (dbSelect && !dbSelect.value) {
        showToast("Seleziona una materia prima di iniziare.");
        return;
    }

    if (mode === "exam" && isExamMode && !examFinished && examQuestions.length) {
        const { unanswered } = getExamAnswerCounts();
        const restart = await askForConfirmation({
            title: "Creare una nuova simulazione?",
            message: "La simulazione in corso verrà sostituita.",
            detail: unanswered
                ? `Hai ancora ${unanswered} ${unanswered === 1 ? "domanda senza risposta" : "domande senza risposta"}.`
                : "Hai già risposto a tutte le domande, ma non hai ancora consegnato.",
            confirmLabel: "Crea nuovo test",
            cancelLabel: "Continua quello attuale",
            danger: true
        });
        if (!restart) return;
    }

    await withCardLoader(async () => {
        if (mode === "exam") {
            await startExamMode();
        } else {
            await startTrainingMode();
        }
    }, "Caricamento domanda…");
}

async function requestModeChange(newMode) {
    if (newMode === mode) return true;
    if (isExamMode && !examFinished && examQuestions.length) {
        const { answered, total } = getExamAnswerCounts();
        const leave = await askForConfirmation({
            title: "Uscire dalla simulazione?",
            message: "Passando ad Allenamento perderai il test in corso.",
            detail: `Hai risposto a ${answered} domande su ${total}.`,
            confirmLabel: "Esci dal test",
            cancelLabel: "Resta in simulazione",
            danger: true
        });
        if (!leave) return false;
    }
    setMode(newMode);
    return true;
}

function setMode(newMode) {
    quizVoice.cancelAutoAdvance();
    cancelPendingNavigation();
    mode = newMode;

    // attiva tab corretta
    document.querySelectorAll(".mode-tab").forEach((btn) => {
        btn.classList.toggle("active", btn.dataset.mode === newMode);
    });

    // mostra/nasconde blocchi impostazioni
    document.getElementById("trainingSettings").style.display =
        newMode === "training" ? "block" : "none";
    document.getElementById("examSettings").style.display =
        newMode === "exam" ? "block" : "none";

    // pool slider section (solo in simulazione)
    if (newMode === "exam") {
        renderPoolSlidersFromDbSources();
    } else {
        hidePoolSection();
        showPoolWarning("");
    }

    // se esco da exam, stop sidebar, progress e timer
    if (newMode !== "exam") {
        isExamMode = false;
        examFinished = false;
        examQuestions = [];
        examAnswers = [];
        renderExamSidebar();
        updateProgress();
        stopExamTimer();
    }

    hideExamSummary();
    updateActiveReviewProgress();
}

function pulseStar() {
    const btn = document.getElementById("saveStar");
    if (!btn) return;
    btn.classList.remove("pulse");
    // force reflow
    void btn.offsetWidth;
    btn.classList.add("pulse");
    setTimeout(() => btn.classList.remove("pulse"), 220);
}

function animateCardSlide(direction) {
    const card = document.querySelector(".question-card");
    if (!card) return Promise.resolve();
    const cls = direction === "next" ? "slide-left" : "slide-right";
    card.classList.remove("slide-left", "slide-right");
    void card.offsetWidth;
    card.classList.add(cls);
    return new Promise((resolve) => {
        setTimeout(() => {
            card.classList.remove(cls);
            resolve();
        }, 150);
    });
}

async function toggleStarSaved() {
    // determina id domanda corrente
    const domandaIdEl = document.getElementById("domanda-id");
    if (!domandaIdEl) return;
    const m = domandaIdEl.innerText.match(/ID Domanda:\s*(\d+)/);
    if (!m) return;
    const qid = Number(m[1]);
    const starButton = document.getElementById("saveStar");
    if (starButton?.disabled) return;

    const isSaved = savedIdSet.has(qid);
    const url = isSaved ? `/api/remove_saved_question/${qid}` : `/api/save_question/${qid}`;
    const method = isSaved ? "DELETE" : "POST";

    let data;
    if (starButton) starButton.disabled = true;
    try {
        data = await safeFetchJson(url, { method });
    } catch (error) {
        showToast(error.message || "Errore nel salvataggio", "error");
        if (starButton) starButton.disabled = false;
        return;
    }
    if (starButton) starButton.disabled = false;

    if (isSaved) savedIdSet.delete(qid);
    else savedIdSet.add(qid);

    updateSavedCount(data?.count ?? savedIdSet.size);
    if (getRenderedQuestionId() === qid) updateStarForQuestionId(qid);
    else updateStarForCurrent();
    pulseStar();

    if (isSaved && isSavedQuiz && activeListQuizKind === "saved") {
        const removedIndex = savedQuestions.findIndex((q) => Number(q.id) === qid);
        if (removedIndex >= 0) savedQuestions.splice(removedIndex, 1);
        if (!savedQuestions.length) {
            isSavedQuiz = false;
            activeListQuizKind = null;
            currentQuestionIndex = 1;
            showToast("Non ci sono più domande salvate.");
            return;
        }
        currentQuestionIndex = Math.min(currentQuestionIndex, savedQuestions.length - 1);
        loadSavedQuestion();
    }
}




// Wrappers con animazione per i bottoni (oltre allo swipe)
let navigationBusy = false;
let queuedNavigation = null;
let navigationGeneration = 0;

function hasRenderedQuestion() {
    return /ID Domanda:\s*\d+/.test(
        document.getElementById("domanda-id")?.innerText || ""
    );
}

function setNavigationButtonsBusy(busy) {
    ["nextBtn", "prevBtn"].forEach((id) => {
        const button = document.getElementById(id);
        if (button) button.disabled = busy || quizBusy;
    });
    const finishButton = document.getElementById("finishExamBtn");
    if (finishButton) finishButton.disabled = busy || quizBusy;
    if (!busy) updateExamControls();
}

function cancelPendingNavigation() {
    quizVoice.cancelAutoAdvance();
    navigationGeneration++;
    navigationBusy = false;
    queuedNavigation = null;
    const card = document.querySelector(".question-card");
    if (card) card.classList.remove("slide-left", "slide-right");
    setNavigationButtonsBusy(false);
}

function bringQuestionIntoView() {
    const card = document.querySelector(".question-card");
    if (!card || examFinished) return;
    const rect = card.getBoundingClientRect();
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    if (rect.top < 8 || rect.top > viewportHeight * 0.35) {
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        card.scrollIntoView({
            behavior: reduceMotion ? "auto" : "smooth",
            block: "start"
        });
    }
}

async function runNavigation(direction) {
    quizVoice.cancelAutoAdvance();
    if (!hasRenderedQuestion()) return;
    if (quizBusy || navigationBusy) {
        queuedNavigation = direction;
        return;
    }

    navigationBusy = true;
    const generation = navigationGeneration;
    setNavigationButtonsBusy(true);
    try {
        await animateCardSlide(direction);
        if (generation !== navigationGeneration) return;
        if (direction === "next") {
            await nextQuestionOriginal();
        } else {
            await prevQuestionOriginal();
        }
        if (generation === navigationGeneration) {
            requestAnimationFrame(bringQuestionIntoView);
        }
    } catch (error) {
        console.error(error);
        showToast(error.message || "Impossibile cambiare domanda.", "error");
    } finally {
        if (generation !== navigationGeneration) return;
        navigationBusy = false;
        setNavigationButtonsBusy(false);
        const pending = queuedNavigation;
        queuedNavigation = null;
        if (pending && !examFinished) {
            setTimeout(() => runNavigation(pending), 0);
        }
    }
}

function nextQuestion() {
    void runNavigation("next");
}

function prevQuestion() {
    void runNavigation("prev");
}

function initBackToTop() {
    const button = document.getElementById("backToTopBtn");
    if (!button) return;

    let framePending = false;
    const updateVisibility = () => {
        framePending = false;
        const scrollTop = window.scrollY || document.documentElement.scrollTop || 0;
        const visible = scrollTop > 520;
        button.classList.toggle("visible", visible);
        button.setAttribute("aria-hidden", visible ? "false" : "true");
        button.tabIndex = visible ? 0 : -1;
    };

    window.addEventListener("scroll", () => {
        if (framePending) return;
        framePending = true;
        requestAnimationFrame(updateVisibility);
    }, { passive: true });

    button.addEventListener("click", () => {
        const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches;
        window.scrollTo({
            top: 0,
            behavior: reduceMotion ? "auto" : "smooth"
        });
        button.blur();
    });

    updateVisibility();
}


/* INIT */
window.addEventListener("DOMContentLoaded", async () => {
    initSwipeNavigationOnce();
    initBackToTop();
    quizVoice.init();

    // ---- DATABASE SELECT ----
    try {
        await loadDbOptions();
    } catch (error) {
        showToast(error.message || "Impossibile caricare le materie", "error");
    }

    // pre-carico info fonti/pool per la materia attiva
    try {
        const dbSelectInit = document.getElementById("dbSelect");
        const dbKeyInit = dbSelectInit ? dbSelectInit.value : "";
        if (dbKeyInit) {
            const rInfo = await fetch(`/api/database_info?db_key=${encodeURIComponent(dbKeyInit)}`, { credentials: "same-origin", cache: "no-store" });
            const jInfo = await rInfo.json();
            window.__DB_SOURCES__ = Array.isArray(jInfo.sources) ? jInfo.sources : [];
        } else {
            window.__DB_SOURCES__ = [];
        }
    } catch(e) {
        window.__DB_SOURCES__ = [];
    }


    await fetchQuestionsCount();
    await refreshSavedState();
    initPersonalReview();
    await refreshReviewStats();

    // ---- EXPORT PDF (materia corrente) ----
    const exportBtn = document.getElementById("exportPdfBtn");
    if (exportBtn) {
        exportBtn.addEventListener("click", async () => {
            try {
                // check rapido per evitare di scaricare un JSON di errore
                const r = await fetch("/api/export_pdf?check=1", { credentials: "same-origin" });
                const data = await r.json().catch(() => ({}));
                if (!r.ok) {
                    showToast(data.error || "Seleziona prima una materia.", "error");
                    return;
                }
                window.location.href = "/api/export_pdf";
            } catch (e) {
                window.location.href = "/api/export_pdf";
            }
        });
    }

    const dbSelect = document.getElementById("dbSelect");
    if (dbSelect) {
        dbSelect.addEventListener("change", async () => {
            if (!dbSelect.value) return;
            await setDatabase(dbSelect.value);
        });
    }

    const startBtn = document.getElementById("startButton");
    if (startBtn) startBtn.onclick = startQuiz;

    const startSavedBtn = document.getElementById("startSavedButton");
    if (startSavedBtn) startSavedBtn.onclick = startSavedQuiz;

    const resetBtn = document.getElementById("resetSessionBtn");
    if (resetBtn) resetBtn.onclick = resetSession;

    const starBtn = document.getElementById("saveStar");
    if (starBtn) {
        starBtn.addEventListener("click", async (e) => {
            e.preventDefault();
            e.stopPropagation();
            await toggleStarSaved();
        });
    }

    const finishExamBtn = document.getElementById("finishExamBtn");
    if (finishExamBtn) {
        finishExamBtn.addEventListener("click", () => void requestFinishExam());
    }

    const confirmModal = document.getElementById("confirmModal");
    const confirmAccept = document.getElementById("confirmModalAccept");
    const confirmCancel = document.getElementById("confirmModalCancel");
    if (confirmAccept) confirmAccept.addEventListener("click", () => closeConfirmModal(true));
    if (confirmCancel) confirmCancel.addEventListener("click", () => closeConfirmModal(false));
    if (confirmModal) {
        confirmModal.addEventListener("click", (event) => {
            if (event.target === confirmModal) closeConfirmModal(false);
        });
        confirmModal.addEventListener("keydown", (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                closeConfirmModal(false);
            }
        });
    }

    // tab modalità
    document.querySelectorAll(".mode-tab").forEach((btn) => {
        btn.addEventListener("click", () => {
            void requestModeChange(btn.dataset.mode);
        });
    });

    // nascondo nav all'inizio
    const nextBtn = document.getElementById("nextBtn");
    const prevBtn = document.getElementById("prevBtn");
    const finishBtn = document.getElementById("finishExamBtn");
    if (nextBtn) nextBtn.style.display = "none";
    if (prevBtn) prevBtn.style.display = "none";
    if (finishBtn) finishBtn.style.display = "none";

    updateSavedCount();
    updateSessionStats();
    renderExamSidebar();
    updateProgress();
    // init menu profilo (avatar)
    initUserMenu();
    initQuestionSearch();
});

(function () {
  const btn = document.getElementById("dbInfoBtn");
  const pop = document.getElementById("dbInfoPopover");
  const body = document.getElementById("dbInfoBody");
  const title = document.getElementById("dbInfoTitle");
  const sel = document.getElementById("dbSelect"); // deve esistere già

  if (!btn || !pop || !body || !title || !sel) return;

  // overlay per mobile (creato via JS così non tocchi l'HTML)
  let overlay = document.querySelector(".db-info-overlay");
  if (!overlay) {
    overlay = document.createElement("div");
    overlay.className = "db-info-overlay";
    document.body.appendChild(overlay);
  }

  let lastKey = null;
  let isOpen = false;

  function isMobile() {
    return window.matchMedia("(max-width: 720px)").matches;
  }

  function escapeHtml(s) {
    return String(s ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  function placePopoverDesktop() {
    const r = btn.getBoundingClientRect();
    const gap = 10;

    // Popover sotto al bottone
    let top = r.bottom + gap;
    let left = r.left; // parte dal lato sinistro del bottone (effetto "spuntare da lì")

    // dopo open serve dimensioni reali
    const pw = pop.offsetWidth;
    const ph = pop.offsetHeight;

    // clamp viewport
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // se sfora a destra, spostalo a sinistra
    if (left + pw > vw - 10) left = vw - pw - 10;
    if (left < 10) left = 10;

    // se sfora in basso, prova sopra al bottone (fallback)
    if (top + ph > vh - 10) top = r.top - ph - gap;
    if (top < 10) top = 10;

    pop.style.left = `${left}px`;
    pop.style.top  = `${top}px`;

    // freccetta: posizionala “sotto” al bottone, dentro il popover
    const centerX = r.left + (r.width / 2);
    let arrowLeft = centerX - left - 6; // 6 = metà della freccia (12px)
    arrowLeft = Math.max(14, Math.min(pw - 14, arrowLeft));
    pop.style.setProperty("--db-info-arrow-left", `${arrowLeft}px`);

    // origine animazione vicino alla freccetta (effetto "spuntare")
    pop.style.transformOrigin = `${arrowLeft + 6}px 0px`;
  }


  function openPopover() {
    btn.classList.add("is-open");
    pop.classList.add("open");
    pop.setAttribute("aria-hidden", "false");
    isOpen = true;

    if (isMobile()) {
      overlay.classList.add("open");
    } else {
      overlay.classList.remove("open");
      // dopo display:block serve un frame per offsetWidth/Height corretti
      requestAnimationFrame(() => placePopoverDesktop());
    }
  }

  function closePopover() {
    btn.classList.remove("is-open");
    pop.classList.remove("open");
    pop.setAttribute("aria-hidden", "true");
    overlay.classList.remove("open");
    isOpen = false;
  }

  async function loadInfo(force = false) {
    const dbKey = sel.value;
    if (!dbKey) {
      title.textContent = "Info database";
      body.textContent = "Seleziona una materia.";
      return;
    }

    if (!force && lastKey === dbKey && body.dataset.loaded === "1") return;

    body.dataset.loaded = "0";
    title.textContent = "Info database";
    body.textContent = "Caricamento…";

    try {
      const r = await fetch(`/api/database_info?db_key=${encodeURIComponent(dbKey)}`, {
        credentials: "same-origin",
        cache: "no-store"
      });
      const j = await r.json();

      title.textContent = j.title ? j.title : "Info database";

      const total = (j && j.total != null) ? Number(j.total) : null;
const sources = Array.isArray(j.sources) ? j.sources : [];

// espongo per la sezione slider (simulazione)
window.__DB_SOURCES__ = sources;

if (!sources.length) {
  body.innerHTML = `<div class="db-info-row">Nessuna informazione disponibile.</div>`;
} else {
  const totalTxt = (total != null) ? `<div class="db-info-row"><b>Totale domande:</b> ${total}</div>` : "";
  const list = sources.map(s => {
    const src = escapeHtml(s.source || "(senza fonte)");
    const a = Number(s.from || 0);
    const b = Number(s.to || 0);
    const n = Number(s.count || 0);
    const pct = (total && total > 0) ? ((n * 100) / total).toFixed(2) : "0.00";
    const note = s.note ? `<div class="db-info-note">${escapeHtml(s.note)}</div>` : "";
    const rangeTxt = (a && b) ? `domande ${a}-${b}` : "";
    return `
      <div class="db-info-row">
        <div><b>${src}</b>: ${rangeTxt} • ${n} (${pct}%)</div>
        ${note}
      </div>`;
  }).join("");
  body.innerHTML = `${totalTxt}<div class="db-info-section"><b>Pool/Fonti:</b></div>${list}`;
}

body.dataset.loaded = "1";
lastKey = dbKey;
    } catch (e) {
      body.textContent = "Errore nel caricamento delle informazioni.";
    }
  }

  btn.addEventListener("click", async (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (isOpen) { closePopover(); return; }
    await loadInfo(false);
    openPopover();
  }, { passive: false });

  // Se cambia materia e popover aperto, aggiorna e riposiziona
  sel.addEventListener("change", async () => {
    body.dataset.loaded = "0";
    lastKey = null;
    if (isOpen) {
      await loadInfo(true);
      if (!isMobile()) requestAnimationFrame(() => placePopoverDesktop());
    }
  });

  // chiusura clic fuori (desktop) / overlay (mobile)
  overlay.addEventListener("click", () => closePopover());

  document.addEventListener("click", (e) => {
    if (!isOpen) return;
    const inside = pop.contains(e.target) || btn.contains(e.target);
    if (!inside) closePopover();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && isOpen) closePopover();
  });

  // riposiziona su resize/scroll (desktop)
  window.addEventListener("resize", () => {
    if (isOpen && !isMobile()) placePopoverDesktop();
  }, { passive: true });

  window.addEventListener("scroll", () => {
    if (isOpen && !isMobile()) placePopoverDesktop();
  }, { passive: true });
})();


/* ================================================================
   QUIZ_VOICE_CONTROL_V5 — comandi espliciti e feedback diagnostico
   Nessuna API server/DB modificata. Lettere riferite all'ordine DOM.
   ================================================================ */
const quizVoice = (() => {
    "use strict";
    const STORAGE_KEY = "universityQuiz.voicePrefs.v1";
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
    const RESTART_DELAY = 350;
    const MAX_RESTART_DELAY = 12000;
    const INTERIM_SETTLE_MS = 90; // frasi COMPLETE, nessuna attesa sulla singola lettera
    const COMMAND_COOLDOWN_MS = 350;
    let recognition = null;
    let enabled = false;
    let paused = false;
    let active = false;
    let starting = false;
    let autoAdvance = true;
    let delayMs = 2000;
    let advanceTimer = null;
    let restartTimer = null;
    let questionVersion = 0;
    let lastCommandTime = 0;
    let lastCommandVersion = -1;
    let lastCommandSignature = null;
    let retryCount = 0;
    let recoveryTimer = null;
    let startWatchdog = null;
    let lastReportedTranscript = "";
    let initialized = false;
    let savingVoiceQuestion = false;
    let interimTimer = null;
    let pendingInterim = null;
    const consumedResultIndices = new Set();
    const BANNER_STORAGE_KEY = "universityQuiz.voiceBannerDismissed.v2";

    const byId = (id) => document.getElementById(id);
    const hasModal = () => Array.from(document.querySelectorAll(".modal"))
        .some((el) => el.style.display !== "none" && getComputedStyle(el).display !== "none");

    function setStatus(message, kind = "idle") {
        const el = byId("voiceStatus");
        if (el) {
            el.textContent = message;
            el.dataset.state = kind;
        }
        const activity = byId("voiceActivity");
        if (activity) {
            activity.dataset.state = kind;
            activity.setAttribute("aria-label", kind === "hearing" ? "Voce rilevata" :
                kind === "listening" ? "In ascolto" : kind === "pending" ? "Attivazione" :
                kind === "waiting" ? "Correzione visibile" : kind === "paused" ? "In pausa" : "Microfono non in ascolto");
        }
    }

    function updateUi() {
        const button = byId("voiceToggleBtn");
        const auto = byId("voiceAutoAdvance");
        const wait = byId("voiceAdvanceDelay");
        const panel = byId("voicePanel");
        const bannerStart = byId("voiceBannerStart");
        if (button) {
            button.disabled = !Recognition;
            button.setAttribute("aria-pressed", String(enabled));
            button.setAttribute("aria-label", enabled ? "Disattiva microfono per i quiz" : "Attiva microfono per i quiz");
            button.title = enabled ? "Disattiva microfono" : "Attiva microfono";
            button.classList.toggle("is-active", enabled);
            const icon = button.querySelector("i");
            if (icon) icon.className = enabled ? "fa-solid fa-microphone" : "fa-solid fa-microphone-slash";
            const label = byId("voiceToggleLabel");
            if (label) label.innerHTML = enabled ? '<span class="voice-toggle-label-short">Voce ON</span><span class="voice-toggle-label-full">Voce attiva</span>' : '<span class="voice-toggle-label-short">Voce OFF</span><span class="voice-toggle-label-full">Voce spenta</span>';
        }
        if (bannerStart) bannerStart.disabled = !Recognition;
        if (auto) auto.checked = autoAdvance;
        if (wait) {
            wait.value = String(delayMs);
            wait.disabled = !autoAdvance;
        }
        const summary = byId("voiceDelaySummary");
        if (summary) summary.textContent = autoAdvance
            ? `Avanzamento automatico · ${delayMs / 1000} s`
            : "Avanzamento manuale";
        if (panel) {
            panel.classList.toggle("voice-enabled", enabled);
            const settings = byId("voiceSettings");
            panel.classList.toggle("voice-settings-open", !!settings && !settings.hidden);
        }
    }

    function savePreferences() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify({ autoAdvance, delayMs }));
        } catch (_) { /* browser/storage privato: preferenze solo in memoria */ }
    }

    function cancelPendingInterim() {
        if (interimTimer !== null) clearTimeout(interimTimer);
        interimTimer = null;
        pendingInterim = null;
    }

    function cancelAutoAdvance() {
        questionVersion++;
        cancelPendingInterim();
        if (advanceTimer !== null) clearTimeout(advanceTimer);
        advanceTimer = null;
    }

    function clearRestartTimers() {
        if (restartTimer !== null) clearTimeout(restartTimer);
        if (recoveryTimer !== null) clearTimeout(recoveryTimer);
        if (startWatchdog !== null) clearTimeout(startWatchdog);
        restartTimer = null;
        recoveryTimer = null;
        startWatchdog = null;
    }

    function stopRecognition() {
        cancelPendingInterim();
        clearRestartTimers();
        // Invalidare prima l'istanza: i suoi callback asincroni (onend/onerror)
        // non devono disabilitare o riavviare una sessione successiva.
        const previous = recognition;
        recognition = null;
        active = false;
        starting = false;
        if (previous) {
            try { previous.abort(); } catch (_) { /* già terminato */ }
        }
    }

    function switchOff(message = "Microfono disattivato.", state = "idle") {
        enabled = false;
        paused = false;
        retryCount = 0;
        cancelAutoAdvance();
        stopRecognition();
        const settings = byId("voiceSettings");
        const settingsButton = byId("voiceSettingsBtn");
        if (settings && !settings.hidden) {
            settings.hidden = true;
            settingsButton?.setAttribute("aria-expanded", "false");
        }
        updateUi();
        setStatus(message, state);
    }

    function scheduleRestart(delay, message) {
        if (!enabled || document.hidden) return;
        if (restartTimer !== null) clearTimeout(restartTimer);
        const wait = Math.min(MAX_RESTART_DELAY, Math.max(RESTART_DELAY, delay));
        if (advanceTimer === null && !paused) {
            setStatus(message || `Ricollegamento del microfono tra ${Math.max(1, Math.ceil(wait / 1000))} s…`, "pending");
        }
        restartTimer = setTimeout(() => {
            restartTimer = null;
            startRecognition();
        }, wait);
    }

    function startRecognition() {
        if (!enabled || !Recognition || recognition || active || starting || document.hidden) return;
        if (restartTimer !== null) {
            clearTimeout(restartTimer);
            restartTimer = null;
        }
        let instance;
        try {
            instance = new Recognition();
        } catch (_) {
            retryCount = Math.min(retryCount + 1, 8);
            scheduleRestart(RESTART_DELAY * (2 ** Math.min(retryCount, 5)), "In attesa del servizio vocale…");
            return;
        }
        recognition = instance;
        starting = true;
        let sessionStartedAt = 0;
        let transientError = null;
        let hasEnded = false;
        instance.lang = "it-IT";
        instance.continuous = true;
        instance.interimResults = true;
        instance.maxAlternatives = 3;

        const isCurrent = () => recognition === instance;
        function finishSession({ force = false } = {}) {
            if (!isCurrent() || hasEnded) return;
            hasEnded = true;
            // Non riutilizzare un'istanza conclusa: in Chrome start() può altrimenti
            // generare InvalidStateError e far sembrare spento il microfono.
            recognition = null;
            active = false;
            starting = false;
            cancelPendingInterim();
            if (recoveryTimer !== null) clearTimeout(recoveryTimer);
            if (startWatchdog !== null) clearTimeout(startWatchdog);
            recoveryTimer = null;
            startWatchdog = null;
            if (force) {
                try { instance.abort(); } catch (_) { /* sessione già terminata */ }
            }
            if (!enabled || document.hidden) return;
            const livedMs = sessionStartedAt ? (Date.now() - sessionStartedAt) : 0;
            if (livedMs > 5000 && !transientError) retryCount = 0;
            else retryCount = Math.min(retryCount + 1, 8);
            const wait = transientError
                ? Math.min(MAX_RESTART_DELAY, 750 * (2 ** Math.min(retryCount - 1, 5)))
                : retryCount <= 2 ? RESTART_DELAY
                    : Math.min(MAX_RESTART_DELAY, RESTART_DELAY * (2 ** Math.min(retryCount - 2, 5)));
            scheduleRestart(wait, transientError
                ? "Servizio vocale temporaneamente non disponibile. Riprovo automaticamente…"
                : "Ascolto interrotto dal browser. Riattivazione automatica…");
        }

        instance.onstart = () => {
            if (!isCurrent()) return;
            active = true;
            starting = false;
            sessionStartedAt = Date.now();
            consumedResultIndices.clear();
            if (startWatchdog !== null) clearTimeout(startWatchdog);
            startWatchdog = null;
            if (enabled && !paused && advanceTimer === null)
                setStatus("In ascolto: di’ «Rispondi A», «Rispondi B», «Rispondi C» o «Rispondi D».", "listening");
        };
        instance.onspeechstart = () => {
            if (isCurrent() && enabled && !paused && advanceTimer === null)
                setStatus("Voce rilevata · sto interpretando…", "hearing");
        };
        instance.onspeechend = () => {
            if (isCurrent() && enabled && !paused && advanceTimer === null &&
                byId("voiceStatus")?.dataset.state === "hearing")
                setStatus("In ascolto · di’ «Rispondi A/B/C/D».", "listening");
        };
        instance.onresult = (event) => {
            if (!isCurrent()) return;
            retryCount = 0; // prova concreta che il servizio è tornato a funzionare
            handleRecognitionResult(event);
        };
        instance.onerror = (event) => {
            if (!isCurrent()) return;
            const error = event?.error || "unknown";
            if (["not-allowed", "service-not-allowed"].includes(error)) {
                switchOff("Permesso microfono negato o servizio bloccato. Controlla i permessi del sito.", "warning");
                return;
            }
            if (error === "audio-capture") {
                switchOff("Microfono non disponibile. Verifica dispositivo e permessi.", "warning");
                return;
            }
            if (error === "language-not-supported") {
                switchOff("Il riconoscimento vocale in italiano non è supportato da questo browser.", "warning");
                return;
            }
            // 'no-speech' e 'aborted' non sono un comando di spegnimento.
            // 'network' è temporaneo: attendiamo onend e ritentiamo con backoff.
            transientError = error === "network" || error === "unknown" ? error : null;
            if (transientError) {
                setStatus("Problema temporaneo del servizio vocale. Riconnessione automatica…", "warning");
            }
            // Alcuni browser emettono onerror senza onend: recupero protetto.
            if (recoveryTimer !== null) clearTimeout(recoveryTimer);
            recoveryTimer = setTimeout(() => finishSession({ force: true }), 1400);
        };
        instance.onend = () => finishSession();

        try {
            instance.start();
            // L'API può non emettere né onstart né onerror: mostra un problema reale
            // invece di rimanere per sempre su «attivazione».
            startWatchdog = setTimeout(() => {
                startWatchdog = null;
                if (isCurrent() && starting && !active) {
                    setStatus("Il servizio vocale non risponde. Nuovo tentativo; controlla connessione e browser.", "warning");
                    finishSession({ force: true });
                }
            }, 6500);
            if (isCurrent() && advanceTimer === null && !paused) setStatus("Attivazione del microfono…", "pending");
        } catch (error) {
            recognition = null;
            active = false;
            starting = false;
            if (error?.name === "NotAllowedError" || error?.name === "SecurityError") {
                switchOff("Autorizzazione del microfono necessaria. Controlla i permessi del sito.", "warning");
                return;
            }
            retryCount = Math.min(retryCount + 1, 8);
            scheduleRestart(Math.min(MAX_RESTART_DELAY, 500 * (2 ** Math.min(retryCount, 5))),
                "Il browser ha interrotto l'avvio dell'ascolto. Riprovo automaticamente…");
        }
    }

    function normalizeSpeech(value) {
        return String(value || "")
            .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
            .toLocaleLowerCase("it-IT")
            .replace(/[.,!?;:]/g, " ").replace(/\s+/g, " ").trim();
    }

    function decodeCommand(value) {
        const txt = normalizeSpeech(value);
        // Solo la formula esplicita «Rispondi A/B/C/D» può selezionare una risposta.
        // Lettere singole e parole simili ('a' preposizione, 'di') non devono rispondere.
        const hit = txt.match(/^rispondi\s+(?:(?:con|la|alla|opzione|risposta|lettera)\s+)?(a|b|c|d|bi|ci|di|be|ce|de)$/);
        if (hit) {
            const letter = { a: "A", b: "B", bi: "B", be: "B", c: "C", ci: "C", ce: "C", d: "D", di: "D", de: "D" }[hit[1]];
            if (letter) return letter;
        }
        const actions = {
            "pausa": "pause", "metti in pausa": "pause", "ferma quiz": "pause",
            "riprendi": "resume", "continua quiz": "resume",
            "prossima": "next", "prossima domanda": "next", "avanti": "next",
            "precedente": "previous", "domanda precedente": "previous", "indietro": "previous",
            "disattiva microfono": "off", "spegni microfono": "off",
            "salva domanda": "save", "salva la domanda": "save", "salva questa domanda": "save",
            "rimuovi salvataggio": "unsave", "rimuovi domanda salvata": "unsave", "togli salvataggio": "unsave"
        };
        return actions[txt] || null;
    }

    function explainUnrecognized(transcript) {
        const heard = String(transcript || "").trim().slice(0, 75);
        if (!heard || !enabled || paused || advanceTimer !== null) return;
        // Mostriamo la trascrizione sul browser (non viene salvata o inviata a Flask).
        // È utile per capire se il problema è il microfono o la grammatica.
        if (lastReportedTranscript !== heard) {
            lastReportedTranscript = heard;
            setStatus(`Ho sentito «${heard}». Per rispondere di’ «Rispondi A», «Rispondi B», «Rispondi C» o «Rispondi D».`, "warning");
        }
    }

    function mayAct() {
        return enabled && !document.hidden && !hasModal() && !quizBusy &&
            !navigationBusy && !examFinished && hasRenderedQuestion() &&
            byId("risposte")?.querySelectorAll("li[data-answer-id]").length > 0;
    }

    function applyCommand(command) {
        if (command === "off") { switchOff(); return true; }
        if (command === "pause") {
            paused = true;
            cancelAutoAdvance();
            setStatus("In pausa. Pronuncia «riprendi» per continuare.", "paused");
            return true;
        }
        if (command === "resume") {
            paused = false;
            setStatus("Ascolto ripreso: di’ «Rispondi A/B/C/D».", "listening");
            return true;
        }
        if (paused || !mayAct() || savingVoiceQuestion) return false;
        if (command === "save" || command === "unsave") {
            const id = getRenderedQuestionId();
            if (!id) return false;
            const alreadySaved = savedIdSet.has(id);
            if (command === "save" && alreadySaved) {
                setStatus("Questa domanda è già salvata.", "listening");
                return true;
            }
            if (command === "unsave" && !alreadySaved) {
                setStatus("Questa domanda non è tra le salvate.", "listening");
                return true;
            }
            savingVoiceQuestion = true;
            // Non avanzare mentre la richiesta di salvataggio è in corso.
            const resumeCountdown = advanceTimer !== null && mode === "training" && hasAnsweredCurrent;
            if (resumeCountdown) cancelAutoAdvance();
            setStatus(command === "save" ? "Salvataggio domanda…" : "Rimozione salvataggio…", "pending");
            void (async () => {
                try {
                    await toggleStarSaved(); // funzione esistente: stesso DB e stesso flusso della stellina
                    if (getRenderedQuestionId() === id) {
                        const done = savedIdSet.has(id) === (command === "save");
                        setStatus(done
                            ? (command === "save" ? "Domanda salvata." : "Domanda rimossa dalle salvate.")
                            : "Operazione non completata. Riprova.", done ? "listening" : "warning");
                    }
                } finally {
                    savingVoiceQuestion = false;
                    if (resumeCountdown && getRenderedQuestionId() === id && hasAnsweredCurrent) {
                        onTrainingAnswered(); // ricomincia l'intervallo completo dopo il salvataggio
                    }
                }
            })();
            return true;
        }
        if (command === "next" || command === "previous") {
            cancelAutoAdvance();
            if (command === "next") nextQuestion();
            else prevQuestion();
            setStatus("Cambio domanda…", "pending");
            return true;
        }
        if (advanceTimer !== null || !/^[A-Z]$/.test(command)) return false;
        if (mode === "exam" && !isExamMode) return false;
        if (mode === "training" && hasAnsweredCurrent) return false;
        const answers = Array.from(byId("risposte")?.querySelectorAll("li[data-answer-id]") || []);
        const index = LETTERS.indexOf(command);
        if (index < 0 || index >= answers.length) return false;
        // Si invoca il click reale: punteggi, persistenza e simulazione restano invariati.
        answers[index].click();
        if (mode === "exam") {
            setStatus(`Comando riconosciuto: «Rispondi ${command}». Di’ «prossima» per avanzare.`, "listening");
        }
        return true;
    }

    function handleRecognitionResult(event) {
        if (!enabled || document.hidden || !event?.results) return;
        for (let idx = event.resultIndex; idx < event.results.length; idx++) {
            const result = event.results[idx];
            if (!result || consumedResultIndices.has(idx)) continue;
            // I risultati definitivi hanno sempre priorità. Se il comando è già
            // partito su un risultato intermedio, l'indice viene ignorato.
            if (result.isFinal) {
                if (pendingInterim?.index === idx) cancelPendingInterim();
                let command = null;
                for (let n = 0; n < result.length; n++) {
                    command = decodeCommand(result[n]?.transcript);
                    if (command) break;
                }
                if (!command) {
                    explainUnrecognized(result[0]?.transcript);
                    continue;
                }
                const now = Date.now();
                const seenVersion = questionVersion;
                if (now - lastCommandTime < COMMAND_COOLDOWN_MS &&
                    lastCommandVersion === seenVersion && lastCommandSignature === command) continue;
                if (applyCommand(command)) {
                    consumedResultIndices.add(idx);
                    lastCommandTime = now;
                    lastCommandVersion = seenVersion;
                    lastCommandSignature = command;
                    lastReportedTranscript = "";
                    return;
                }
                if (!hasRenderedQuestion() && /^[A-D]$/.test(command)) {
                    setStatus("Comando riconosciuto, ma prima devi selezionare una materia e avviare il quiz.", "warning");
                }
                continue;
            }
            // Fast path soltanto per la frase COMPLETA «rispondi X».
            // Bastano 90 ms di stabilità: non dobbiamo aspettare la trascrizione finale.
            // Azioni distruttive/salvataggi/navigazione restano vincolati al finale.
            const transcript = normalizeSpeech(result[0]?.transcript);
            const command = decodeCommand(transcript);
            if (!/^[A-D]$/.test(command || "") || !mayAct() || paused ||
                (mode === "training" && hasAnsweredCurrent) || advanceTimer !== null) {
                if (pendingInterim?.index === idx) cancelPendingInterim();
                continue;
            }
            if (pendingInterim?.index === idx && pendingInterim.transcript === transcript) continue;
            cancelPendingInterim();
            const version = questionVersion;
            pendingInterim = { index: idx, transcript, command, version };
            setStatus("Voce rilevata · verifico la risposta…", "hearing");
            interimTimer = setTimeout(() => {
                const candidate = pendingInterim;
                interimTimer = null;
                pendingInterim = null;
                if (!candidate || candidate.version !== questionVersion ||
                    consumedResultIndices.has(candidate.index) ||
                    (Date.now() - lastCommandTime < COMMAND_COOLDOWN_MS &&
                    lastCommandVersion === candidate.version && lastCommandSignature === candidate.command)) return;
                if (applyCommand(candidate.command)) {
                    consumedResultIndices.add(candidate.index);
                    lastCommandTime = Date.now();
                    lastCommandVersion = candidate.version;
                    lastCommandSignature = candidate.command;
                    lastReportedTranscript = "";
                } else if (!hasRenderedQuestion()) {
                    setStatus("Comando riconosciuto, ma devi prima avviare il quiz.", "warning");
                }
            }, INTERIM_SETTLE_MS);
        }
    }

    function onQuestionRendered() {
        cancelAutoAdvance();
        if (enabled && !paused && !document.hidden) {
            setStatus(active ? "In ascolto · di’ «Rispondi A/B/C/D»." : "Riattivo il riconoscimento…",
                active ? "listening" : "pending");
        }
    }

    function onTrainingAnswered() {
        cancelAutoAdvance();
        if (!enabled || !autoAdvance || paused || document.hidden || mode !== "training") return;
        if (isSavedQuiz && currentQuestionIndex >= savedQuestions.length - 1) {
            setStatus("Ultima domanda del ripasso completata.", "listening");
            return;
        }
        const count = Number(byId("totalQuestions")?.textContent?.replace(/[^\d]/g, "") || 0);
        if (!isSavedQuiz && count > 0 && currentQuestionIndex >= count) {
            setStatus("Ultima domanda della materia completata.", "listening");
            return;
        }
        const version = questionVersion;
        const questionId = getRenderedQuestionId();
        setStatus(`Risposta acquisita · correzione visibile per ${delayMs / 1000} s. Poi passo alla prossima.`, "waiting");
        advanceTimer = setTimeout(() => {
            advanceTimer = null;
            if (!enabled || paused || !autoAdvance || document.hidden ||
                mode !== "training" || !hasAnsweredCurrent || quizBusy || navigationBusy ||
                version !== questionVersion || getRenderedQuestionId() !== questionId || hasModal()) return;
            nextQuestion();
        }, delayMs);
    }

    function init() {
        if (initialized) return;
        initialized = true;
        try {
            const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
            autoAdvance = saved.autoAdvance !== false;
            if ([1000, 2000, 3000, 4000, 5000].includes(saved.delayMs)) delayMs = saved.delayMs;
        } catch (_) { /* preferenze predefinite */ }
        updateUi();
        setStatus(Recognition
            ? "Microfono spento. Attivalo quando vuoi rispondere a voce."
            : "Questo browser non supporta il riconoscimento vocale. Usa Chrome o Edge aggiornato.",
            Recognition ? "idle" : "warning");
        function toggleMicrophone() {
            if (enabled) switchOff();
            else if (Recognition) {
                enabled = true;
                paused = false;
                retryCount = 0;
                updateUi();
                startRecognition(); // direttamente dal clic dell'utente
            }
        }
        byId("voiceToggleBtn")?.addEventListener("click", toggleMicrophone);

        const settingsButton = byId("voiceSettingsBtn");
        const settings = byId("voiceSettings");
        settingsButton?.addEventListener("click", () => {
            if (!settings) return;
            settings.hidden = !settings.hidden;
            settingsButton.setAttribute("aria-expanded", String(!settings.hidden));
            updateUi();
        });

        const banner = byId("voiceIntroBanner");
        function closeBanner() {
            if (!banner) return;
            banner.hidden = true;
            if (byId("voiceBannerDontShow")?.checked) {
                try { localStorage.setItem(BANNER_STORAGE_KEY, "1"); } catch (_) { /* storage non disponibile */ }
            }
        }
        try {
            if (banner && Recognition && localStorage.getItem(BANNER_STORAGE_KEY) !== "1") {
                banner.hidden = false;
            }
        } catch (_) {
            if (banner && Recognition) banner.hidden = false;
        }
        byId("voiceBannerClose")?.addEventListener("click", closeBanner);
        byId("voiceBannerStart")?.addEventListener("click", () => {
            if (!enabled) toggleMicrophone();
            closeBanner();
        });
        byId("voiceAutoAdvance")?.addEventListener("change", (event) => {
            autoAdvance = !!event.target.checked;
            if (!autoAdvance) cancelAutoAdvance();
            updateUi();
            savePreferences();
        });
        byId("voiceAdvanceDelay")?.addEventListener("change", (event) => {
            const ms = Number(event.target.value);
            if (![1000, 2000, 3000, 4000, 5000].includes(ms)) return;
            delayMs = ms;
            cancelAutoAdvance();
            updateUi();
            savePreferences();
        });
        document.addEventListener("visibilitychange", () => {
            if (document.hidden) {
                cancelAutoAdvance();
                stopRecognition();
                if (enabled) setStatus("Pagina in secondo piano. Riattiverò l'ascolto al ritorno.", "paused");
            } else if (enabled) {
                startRecognition();
            }
        });
        window.addEventListener("pagehide", () => { cancelAutoAdvance(); stopRecognition(); });
        window.addEventListener("pageshow", () => {
            if (enabled && !document.hidden && !recognition) startRecognition();
        });
    }

    return { init, cancelAutoAdvance, onQuestionRendered, onTrainingAnswered };
})();
