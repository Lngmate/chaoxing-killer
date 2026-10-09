// ==UserScript==
// @name         超星学习通自动刷课助手（防连跳与空节点增强版）
// @namespace    https://github.com/Lngmate/chaoxing-killer
// @version      2.1.0
// @description  超星学习通/尔雅：自动跳过已完成视频任务点、多视频并发播放、PPT自动滑到底完成任务点、空内容导读自动跳过（带导航保护锁与防连跳机制）、后台播放防暂停、自动静音、自动跳过测验、支持2x倍速。
// @author       Lngmate
// @match        *://*.chaoxing.com/*
// @match        *://*.fanya.chaoxing.com/*
// @match        *://*.xuexi365.net/*
// @match        *://*.erya100.com/*
// @match        *://*.edu.cn/*
// @match        *://*/*studentstudy*
// @match        *://*/*mycourse/stu*
// @match        *://*/*knowledge/cards*
// @updateURL    https://raw.githubusercontent.com/Lngmate/chaoxing-killer/main/chaoxing-helper.user.js
// @downloadURL  https://raw.githubusercontent.com/Lngmate/chaoxing-killer/main/chaoxing-helper.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

(function () {
    'use strict';

    const LOG_PREFIX = '[超星助手]';
    function log(...args) {
        console.log(`%c${LOG_PREFIX}`, 'background:#2563eb;color:#fff;padding:2px 5px;border-radius:3px;', ...args);
    }
    function warn(...args) {
        console.warn(`%c${LOG_PREFIX}`, 'background:#f59e0b;color:#fff;padding:2px 5px;border-radius:3px;', ...args);
    }
    function err(...args) {
        console.error(`%c${LOG_PREFIX}`, 'background:#ef4444;color:#fff;padding:2px 5px;border-radius:3px;', ...args);
    }

    // 判断元素是否在页面中真实可见（兼容 position: fixed 元素，避免 offsetParent 为 null 的陷阱）
    function isElementVisible(el) {
        if (!el) return false;
        try {
            const style = window.getComputedStyle(el);
            if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
            return el.offsetWidth > 0 || el.offsetHeight > 0 || el.getClientRects().length > 0;
        } catch (e) {
            return false;
        }
    }

    // ==========================================
    // 1. 后台防暂停引擎（document-start 最早执行）
    // ==========================================
    function installAntiPauseEngine() {
        try {
            // 核心策略：伪造 Page Visibility API
            Object.defineProperty(Document.prototype, 'hidden', { get: () => false, configurable: true });
            Object.defineProperty(Document.prototype, 'webkitHidden', { get: () => false, configurable: true });
            Object.defineProperty(Document.prototype, 'visibilityState', { get: () => 'visible', configurable: true });
            Object.defineProperty(Document.prototype, 'webkitVisibilityState', { get: () => 'visible', configurable: true });
            Document.prototype.hasFocus = function () { return true; };

            // 劫持 pause()：拦截切屏暂停，支持所有并发视频后台持续播放
            const originalPause = HTMLMediaElement.prototype.pause;
            HTMLMediaElement.prototype.pause = function (...args) {
                const isPopupQuiz = document.querySelector('.ans-videoquiz, .ans-videoquiz-title, #videoquiz-pop');
                const isEnded = this.duration && (this.currentTime >= this.duration - 0.8 || this.ended);
                if (config.enabled && !isPopupQuiz && !isEnded && !this.dataset.userPaused) {
                    log('拦截了一次切屏导致的暂停，维持后台播放');
                    setTimeout(() => { this.play().catch(() => {}); }, 50);
                    return;
                }
                return originalPause.apply(this, args);
            };

            log('防暂停引擎注入完成（已移除 addEventListener 拦截，修复网络卡顿）');
        } catch (e) {
            err('防暂停引擎注入异常:', e);
        }
    }

    installAntiPauseEngine();

    // ==========================================
    // 2. 全局配置
    // ==========================================
    const DEFAULT_CONFIG = {
        enabled: true,
        muted: true,
        playbackRate: 1.0,
        skipQuiz: true,
        jumpDelay: 4000,          // 视频/PPT完成后等待时间（ms）
        backgroundKeepAlive: true,
    };

    function loadConfig() {
        try {
            const saved = localStorage.getItem('CX_HELPER_CONFIG');
            if (saved) return Object.assign({}, DEFAULT_CONFIG, JSON.parse(saved));
        } catch (e) {}
        return Object.assign({}, DEFAULT_CONFIG);
    }

    function saveConfig(cfg) {
        try { localStorage.setItem('CX_HELPER_CONFIG', JSON.stringify(cfg)); } catch (e) {}
    }

    let config = loadConfig();

    // ==========================================
    // 3. 跨 frame 通信
    // ==========================================
    const MSG_PREFIX = 'CX_HELPER_MSG';

    function sendToTop(action, payload = {}) {
        try {
            window.top.postMessage({ prefix: MSG_PREFIX, action, payload }, '*');
        } catch (e) {}
    }

    function broadcastToAllFrames(action, payload = {}) {
        const msg = { prefix: MSG_PREFIX, action, payload };
        try { window.postMessage(msg, '*'); } catch (e) {}
        function sendDown(win) {
            try {
                for (let i = 0; i < win.frames.length; i++) {
                    const subWin = win.frames[i];
                    subWin.postMessage(msg, '*');
                    sendDown(subWin);
                }
            } catch (e) {}
        }
        sendDown(window);
    }

    // ==========================================
    // 4. Web Worker 后台定时器（不受标签页降频影响）
    // ==========================================
    function createBackgroundWorkerTimer(callback, intervalMs = 1500) {
        try {
            const code = `setInterval(() => postMessage('tick'), ${intervalMs});`;
            const blob = new Blob([code], { type: 'application/javascript' });
            const worker = new Worker(URL.createObjectURL(blob));
            worker.onmessage = () => callback();
            return worker;
        } catch (e) {
            return setInterval(callback, intervalMs);
        }
    }

    // ==========================================
    // 5. 无声音频保活（防浏览器内存休眠）
    // ==========================================
    let audioCtx = null;
    function enableAudioKeepAlive() {
        if (audioCtx || !config.backgroundKeepAlive) return;
        try {
            const Ctx = window.AudioContext || window.webkitAudioContext;
            if (!Ctx) return;
            audioCtx = new Ctx();
            const osc = audioCtx.createOscillator();
            const gain = audioCtx.createGain();
            gain.gain.value = 0.00001; // 近乎无声
            osc.connect(gain);
            gain.connect(audioCtx.destination);
            osc.start();
            log('无声保活已激活');
        } catch (e) {}
    }

    window.addEventListener('click', () => {
        enableAudioKeepAlive();
        if (audioCtx && audioCtx.state === 'suspended') audioCtx.resume();
    });

    // ==========================================
    // 6. 全局跳转控制与跨frame多视频中央调度中心
    // ==========================================
    let lastJumpTime = 0;
    let pendingJumpTimer = null;
    let navigatingUntil = 0; // 导航保护锁：在跳转后数秒内绝对禁止任何自动跳节检测
    const JUMP_COOLDOWN_MS = 4000; // 冷却时间缩减至 4 秒，避免卡死

    // 多视频中央调度注册表（解决不同 frame 各自汇报导致总时长跳动和提前跳节的问题）
    const videoRegistry = new Map(); // videoId -> { videoId, current, duration, ended, paused, lastSeen, registeredOrder }
    let activePlayingVideoId = null;
    let allVideosCompletedFired = false;
    let videoRegisterCounter = 0;

    function resetVideoRegistry() {
        videoRegistry.clear();
        activePlayingVideoId = null;
        allVideosCompletedFired = false;
        videoRegisterCounter = 0;
        log('多视频调度注册表已重置');
    }

    function coordinateVideos() {
        if (!config.enabled) return;
        const list = Array.from(videoRegistry.values()).sort((a, b) => a.registeredOrder - b.registeredOrder);
        const total = list.length;
        if (total === 0) return;

        nodeHasTask = true;

        const finishedList = list.filter(v => v.ended);
        const finishedCount = finishedList.length;
        const alreadyDoneList = list.filter(v => v.alreadyFinished);
        const alreadyDoneCount = alreadyDoneList.length;
        const unfinishedList = list.filter(v => !v.ended);

        // 1. 全部视频均已完成（包括之前已完成和刚播完的），才触发跳转！
        if (finishedCount === total && total > 0) {
            if (!allVideosCompletedFired) {
                allVideosCompletedFired = true;
                if (alreadyDoneCount === total) {
                    updateStatus(`本页所有 ${total} 个视频任务点此前均已完成，直接跳往下一节...`);
                    safeJump(() => switchNextTaskOrChapter(), 2000);
                } else {
                    updateStatus(`本页全部 ${total} 个视频已全部看完！${config.jumpDelay / 1000}s 后跳转...`);
                    safeJump(() => switchNextTaskOrChapter(), config.jumpDelay);
                }
            }
            return;
        }

        // 2. 同时并发播放所有未完成的视频（排除已完成的）
        if (unfinishedList.length > 0) {
            // 计算所有未完成视频中最慢的一个剩余时间
            const maxRemaining = Math.max(...unfinishedList.map(v => Math.max(0, (v.duration || 0) - (v.current || 0))));
            const unCount = unfinishedList.length;

            if (alreadyDoneCount > 0) {
                updateStatus(`正在播放 ${unCount} 个未完成视频 (已跳过 ${alreadyDoneCount} 个已完成)，剩余约 ${formatTime(maxRemaining)}`);
            } else if (total === 1) {
                const cur = unfinishedList[0];
                updateStatus(`正在播放视频: ${formatTime(cur.current)} / ${formatTime(cur.duration)}`);
            } else {
                updateStatus(`正在并发播放 ${total} 个视频 (已完成 ${finishedCount}/${total})，剩余约 ${formatTime(maxRemaining)}`);
            }

            // 广播指令：驱动所有 frame 的未完成视频同时播放
            broadcastToAllFrames('VIDEO_CONTROL', {
                command: 'PLAY_UNFINISHED'
            });
        }
    }

    function cancelPendingJump() {
        if (pendingJumpTimer) {
            clearTimeout(pendingJumpTimer);
            pendingJumpTimer = null;
            log('已取消挂起的自动跳转定时器');
        }
    }

    function markNavigating(durationMs = 6000) {
        cancelPendingJump();
        navigatingUntil = Date.now() + durationMs;
        nodeHasTask = false;
        nodeEnterTime = Date.now();
        resetVideoRegistry();
        log(`进入页面过渡保护期 (${durationMs / 1000}秒内禁止任何自动跳节)`);
    }

    function safeJump(jumpFn, delay = config.jumpDelay) {
        const now = Date.now();

        // 如果正处于过渡保护期内，禁止排队新的自动跳转
        if (now < navigatingUntil) {
            log('当前正处于页面加载保护期，忽略自动跳转请求');
            return false;
        }

        // 检查冷却时间
        if (now - lastJumpTime < JUMP_COOLDOWN_MS) {
            const remain = ((JUMP_COOLDOWN_MS - (now - lastJumpTime)) / 1000).toFixed(1);
            log(`跳转冷却中，剩余 ${remain}s，稍后重试`);
            return false;
        }

        cancelPendingJump();

        pendingJumpTimer = setTimeout(() => {
            pendingJumpTimer = null;
            lastJumpTime = Date.now();
            markNavigating(6000); // 触发跳转后立刻锁定 6 秒
            jumpFn();
        }, delay);

        return true;
    }

    // ==========================================
    // 7. 页面就绪后初始化
    // ==========================================
    function onDOMLoaded() {
        log(`页面就绪 URL: ${window.location.href}`);

        const isMainCoursePage = (
            window === window.top ||
            document.querySelector('.posCatalog_level, .posCatalog_select, #iframe, .nextChapter, #prevNextTab, .prev_next') !== null ||
            window.location.href.includes('studentstudy') ||
            window.location.href.includes('mycourse/stu')
        );

        if (isMainCoursePage) {
            initMainPage();
        }

        // Worker 驱动的轮询监控
        createBackgroundWorkerTimer(() => {
            config = loadConfig();
            handleAllVideosInFrame();
            handlePPTInFrame();
            handleQuizInFrame();
            handlePopupQuizInFrame();
        }, 1500);
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', onDOMLoaded);
    } else {
        onDOMLoaded();
    }

    // ==========================================
    // 8. 主控制台：面板 + 消息路由
    // ==========================================
    function initMainPage() {
        log('识别为主控制台，初始化面板...');
        ensureMountUI();

        // 监听 iframe 加载事件，感知章节真正刷新
        const mainIframe = document.querySelector('iframe#iframe') || document.querySelector('iframe');
        if (mainIframe) {
            mainIframe.addEventListener('load', () => {
                log('检测到主内容 iframe 重新加载，重置节点状态并开启保护期');
                markNavigating(6000);
            });
        }

        // 核心拦截：捕获用户在主页面上的任何手动点击跳转行为（下一节、侧边栏目录、选项卡等）
        // 使用捕获阶段 (true)，确保在页面自身响应前立刻终止所有脚本挂起的定时器并上锁
        document.addEventListener('click', (e) => {
            const target = e.target;
            if (!target) return;
            // 忽略助手自身悬浮面板的点击
            if (target.closest && target.closest('#cx-helper-panel')) return;

            const isNavClick = target.closest && target.closest(
                '.nextChapter, .prevChapter, #prevNextTab, .prev_next, .jb_btn, .jb_btn_92, ' +
                '.posCatalog_name, .posCatalog_level, .chapter_item, .clever_posCatalog, ' +
                '.tabshow, .prev_title, .tab-btn, #coursetree, #cells, .catalog_list, ' +
                'a[onclick*="getTeacherAjax"], a[onclick*="nextChapter"], a[onclick*="toChapter"], a[onclick*="study"]'
            );
            if (isNavClick) {
                log('检测到用户手动点击了页面导航/目录/下一节，立即终止所有挂起的跳转并锁定 6 秒');
                cancelPendingJump();
                markNavigating(6000);
            }
        }, true);

        // 监听浏览器前进后退与 Hash 变动
        window.addEventListener('popstate', () => { cancelPendingJump(); markNavigating(6000); });
        window.addEventListener('hashchange', () => { cancelPendingJump(); markNavigating(6000); });

        // 跟踪当前节点的任务状态与跨frame消息路由
        window.addEventListener('message', (e) => {
            const data = e.data;
            if (!data || data.prefix !== MSG_PREFIX) return;

            switch (data.action) {
                case 'VIDEO_REPORT': {
                    const { videoId, current, duration, ended, alreadyFinished, paused } = data.payload;
                    if (!videoRegistry.has(videoId)) {
                        videoRegistry.set(videoId, {
                            videoId, current, duration, ended, alreadyFinished: !!alreadyFinished, paused,
                            lastSeen: Date.now(),
                            registeredOrder: ++videoRegisterCounter
                        });
                        log(`中央调度台注册视频 [${videoId}] (原先已完成: ${!!alreadyFinished})，当前本页总视频数: ${videoRegistry.size}`);
                    } else {
                        const item = videoRegistry.get(videoId);
                        item.current = current;
                        item.duration = duration;
                        item.ended = ended;
                        if (alreadyFinished !== undefined) item.alreadyFinished = !!alreadyFinished;
                        item.paused = paused;
                        item.lastSeen = Date.now();
                    }
                    coordinateVideos();
                    break;
                }
                case 'PPT_FOUND':
                    nodeHasTask = true;
                    updateStatus(`检测到PPT/文档任务，正在自动翻到底部...`);
                    break;
                case 'PPT_DONE':
                    updateStatus(`PPT/文档已翻完！${config.jumpDelay / 1000}s 后跳转...`);
                    if (config.enabled) {
                        safeJump(() => switchNextTaskOrChapter());
                    }
                    break;
                case 'QUIZ_SKIPPED':
                    nodeHasTask = true;
                    updateStatus(`检测到章节测验，已自动跳过...`);
                    if (config.enabled) {
                        safeJump(() => goNextChapter(), 2500);
                    }
                    break;
                case 'POPUP_QUIZ_HANDLED':
                    updateStatus(`视频内嵌弹题已自动作答，继续播放`);
                    break;
            }
        });

        // 定时轮询：检测纯测验章节与空内容/纯文本导读节点
        setInterval(() => {
            if (!config.enabled) return;
            if (config.skipQuiz) checkTopPageForQuiz();
            checkEmptyOrFinishedNode();
        }, 2500);
    }

    // 状态跟踪：用于空内容/无任务点节点跳过
    let currentChapterNodeId = '';
    let nodeEnterTime = Date.now();
    let nodeHasTask = false;

    // 检测空内容 / 纯文本导读 / 无任务点节点，自动跳往下一节
    function checkEmptyOrFinishedNode() {
        const now = Date.now();

        // 1. 如果处于页面过渡/刚跳完的保护期内，绝对不执行跳节检测！
        if (now < navigatingUntil) return;

        const currentActive = document.querySelector('.posCatalog_select, .currents, div[id^="cur"].active');
        const mainIframe = document.querySelector('iframe#iframe') || document.querySelector('iframe');
        
        // 用 iframe 的 src 与当前选中项双重生成页面 Key
        const iframeSrc = (mainIframe && mainIframe.src) ? mainIframe.src.split('?')[1] || '' : '';
        const activeText = currentActive ? (currentActive.id || (currentActive.innerText || '').slice(0, 20)) : '';
        const currentNodeKey = activeText + '|' + iframeSrc;

        // 如果章节节点发生了变化（进入了新节点），重置计时器与任务标志
        if (currentNodeKey && currentNodeKey !== currentChapterNodeId) {
            currentChapterNodeId = currentNodeKey;
            nodeEnterTime = now;
            nodeHasTask = false;
            cancelPendingJump();
            resetVideoRegistry();
            return;
        }

        // 如果当前节点已明确收到过视频/PPT任务消息，绝不当作空节点跳过
        if (nodeHasTask || videoRegistry.size > 0) return;

        // 2. 核心停留缓冲：在新节点必须稳定停留至少 6 秒，确保网络延迟时视频/PPT充分渲染
        if (now - nodeEnterTime < 6000) return;

        // 3. 深入探测主 iframe，核实是否真的没有未完成任务
        let hasActiveTask = false;

        // 顶层若有未完成视频
        if (document.querySelectorAll('video').length > 0) hasActiveTask = true;

        if (mainIframe) {
            try {
                const doc = mainIframe.contentDocument || mainIframe.contentWindow.document;
                if (!doc || !doc.body || doc.readyState === 'loading') return;
                // 若页面完全还是白的或骨架屏，暂不判断，继续等待
                if (doc.body.innerHTML.trim().length < 50) return;

                // 检查视频
                if (doc.querySelectorAll('video').length > 0) hasActiveTask = true;

                // 检查 PPT / 文档阅读器
                if (doc.getElementById('viewerContainer') || doc.querySelector('.pdfViewer, #reader, #scroll_div, #pan-scroll')) {
                    hasActiveTask = true;
                }

                // 检查子 iframe 路径
                doc.querySelectorAll('iframe').forEach(f => {
                    const src = (f.src || '').toLowerCase();
                    if (src.includes('/modules/video/') || src.includes('/modules/pdf/') || src.includes('/modules/doc/') || src.includes('/modules/ppt/')) {
                        hasActiveTask = true;
                    }
                });

                // 检查未完成的任务点图标
                const jobIcons = doc.querySelectorAll('.ans-job-icon');
                jobIcons.forEach(icon => {
                    if (!icon.classList.contains('ans-job-finished')) {
                        hasActiveTask = true;
                    }
                });
            } catch (e) {
                // 跨域忽略
            }
        }

        // 4. 若确认既无视频、无PPT、也无未完成任务点，则安全推进下一节
        if (!hasActiveTask) {
            const nodeTitle = currentActive ? (currentActive.innerText || '').trim().slice(0, 15) : '';
            log(`已核实当前节点[${nodeTitle}]无任务点（纯文本/空节点），即将安全跳转下一节...`);
            updateStatus(`当前为纯文本/无任务点节点，自动跳往下一节...`);
            // 尝试触发安全跳转，成功触发后 nodeEnterTime 会被重置
            const scheduled = safeJump(() => switchNextTaskOrChapter(), 2000);
            if (scheduled) {
                // 避免重复在下一秒重复排队
                nodeEnterTime = Date.now() + 10000;
            }
        }
    }

    // 检测当前选中章节是否是测验
    function checkTopPageForQuiz() {
        const now = Date.now();
        if (now < navigatingUntil) return;

        const currentActive = document.querySelector(
            '.posCatalog_select, .currents, div[id^="cur"].active'
        );
        if (!currentActive) return;

        const text = (currentActive.innerText || '').trim();
        if (text && (text.includes('章节测验') || text.includes('单元测验') || text.includes('章节作业'))) {
            updateStatus(`当前章节为测验/作业[${text.slice(0, 10)}]，自动跳往下一节...`);
            safeJump(() => goNextChapter(), 2500);
        }
    }

    // ==========================================
    // 9. 跳转逻辑
    // ==========================================
    function switchNextTaskOrChapter() {
        log('触发任务点切换...');
        const mainIframe = document.querySelector('iframe#iframe') || document.querySelector('iframe');
        let switchedTab = false;

        if (mainIframe) {
            try {
                const doc = mainIframe.contentDocument || mainIframe.contentWindow.document;
                const tabs = Array.from(doc.querySelectorAll('.prev_title, .tabshow li, .tab-btn'));
                const currentIndex = tabs.findIndex(t => t.classList.contains('active') || t.classList.contains('cur'));

                if (currentIndex !== -1) {
                    for (let j = currentIndex + 1; j < tabs.length; j++) {
                        const tabText = (tabs[j].innerText || tabs[j].getAttribute('title') || '').trim();
                        const isQuiz = tabText.includes('测验') || tabText.includes('作业') || tabText.includes('检测') || tabText.includes('考试');
                        if (config.skipQuiz && isQuiz) {
                            log(`跳过测验任务点: ${tabText}`);
                            continue;
                        }
                        tabs[j].click();
                        switchedTab = true;
                        updateStatus(`已切换至任务点: ${tabText || (j + 1)}`);
                        break;
                    }
                }
            } catch (e) { /* 跨域忽略 */ }
        }

        if (!switchedTab) {
            goNextChapter();
        }
    }

    function goNextChapter() {
        updateStatus('正在跳转至下一章节...');
        log('尝试跳转下一章节...');

        const mainIframe = document.querySelector('iframe#iframe') || document.querySelector('iframe');

        // 策略 0: 超星原生函数
        try {
            if (typeof window.nextChapter === 'function') {
                window.nextChapter();
                updateStatus('已调用 window.nextChapter()');
                return;
            }
        } catch (e) {}

        // 策略 1: 页面上的"下一节"按钮（主窗口 + iframe 双重探测，支持 position:fixed 按钮）
        const nextSelectors = [
            '.nextChapter',
            '#prevNextTab .next',
            '.prev_next .next',
            '.jb_btn.next',
            '.jb_btn_92',
            'a.jb_btn[onclick*="nextChapter"]',
            '.next_title',
            '.orientationright',
            '#toNext',
            '.right_arrow',
            'a[title*="下一节"]',
            'span[title*="下一节"]',
            'div[title*="下一节"]'
        ];

        // 1.1 主页面探测
        for (const sel of nextSelectors) {
            const btn = document.querySelector(sel);
            if (isElementVisible(btn)) {
                btn.click();
                updateStatus('已点击主页面【下一节】');
                return;
            }
        }

        // 1.2 iframe 内部探测
        if (mainIframe) {
            try {
                const subWin = mainIframe.contentWindow;
                const subDoc = mainIframe.contentDocument || subWin.document;
                if (subDoc) {
                    if (subWin && typeof subWin.nextChapter === 'function') {
                        subWin.nextChapter();
                        updateStatus('已调用 iframe 内 nextChapter()');
                        return;
                    }
                    for (const sel of nextSelectors) {
                        const btn = subDoc.querySelector(sel);
                        if (isElementVisible(btn)) {
                            btn.click();
                            updateStatus('已点击 iframe 内【下一节】');
                            return;
                        }
                    }
                }
            } catch (e) {}
        }

        // 策略 2: 侧边栏目录（精准叶子项匹配，绝不混入父级 .posCatalog_level 容器）
        try {
            // 严格只获取叶子可点击项，绝不获取父容器，确保索引 1:1 对应章节
            let items = Array.from(document.querySelectorAll('.posCatalog_name'));
            if (items.length === 0) {
                items = Array.from(document.querySelectorAll('.chapter_item'));
            }
            if (items.length === 0) {
                items = Array.from(document.querySelectorAll('#coursetree a, #cells a, .catalog_list a'));
            }

            const currentActive = document.querySelector(
                '.posCatalog_select, .currents, div[id^="cur"].active, span[id^="cur"].active'
            );

            if (currentActive && items.length > 0) {
                let curIdx = -1;
                for (let i = 0; i < items.length; i++) {
                    const it = items[i];
                    if (it === currentActive || it.contains(currentActive) || currentActive.contains(it) ||
                        it.classList.contains('posCatalog_select') || it.classList.contains('currents') || it.classList.contains('active')) {
                        curIdx = i;
                        break;
                    }
                }

                if (curIdx !== -1 && curIdx + 1 < items.length) {
                    const nextItem = items[curIdx + 1];
                    const clickTarget = nextItem.querySelector('a') || (nextItem.onclick ? nextItem : null) || nextItem;
                    clickTarget.click();
                    updateStatus(`已通过目录切至下一节: ${(nextItem.innerText || '').slice(0, 12)}...`);
                    return;
                }
            }
        } catch (e) { err('目录翻页错误:', e); }

        updateStatus('未找到下一节，课程可能已全部完成');
    }

    // ==========================================
    // 10. 悬浮控制面板
    // ==========================================
    function ensureMountUI() {
        if (document.getElementById('cx-helper-panel')) return;
        const tryMount = () => {
            const container = document.body || document.documentElement;
            if (container) {
                createUI(container);
                log('控制面板挂载成功');
            } else {
                setTimeout(tryMount, 300);
            }
        };
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', tryMount);
        } else {
            tryMount();
        }
    }

    function createUI(parent) {
        if (document.getElementById('cx-helper-panel')) return;
        const box = document.createElement('div');
        box.id = 'cx-helper-panel';
        box.innerHTML = `
            <style>
                #cx-helper-panel {
                    position: fixed !important; top: 75px !important; right: 20px !important;
                    width: 265px !important; background: #fff !important;
                    border-radius: 8px !important; box-shadow: 0 6px 20px rgba(0,0,0,.2) !important;
                    z-index: 2147483647 !important;
                    font-family: -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Arial,sans-serif !important;
                    font-size: 13px !important; color: #333 !important;
                    border: 1px solid #cbd5e1 !important; overflow: hidden !important;
                    user-select: none !important; line-height: 1.5 !important;
                }
                #cx-header {
                    background: #2563eb !important; color: #fff !important;
                    padding: 9px 12px !important; font-weight: 600 !important;
                    display: flex !important; justify-content: space-between !important;
                    align-items: center !important; cursor: move !important;
                }
                #cx-body { padding: 12px !important; }
                .cx-row {
                    display: flex !important; justify-content: space-between !important;
                    align-items: center !important; margin-bottom: 8px !important;
                }
                .cx-status-box {
                    background: #f8fafc !important; border: 1px solid #e2e8f0 !important;
                    border-radius: 5px !important; padding: 6px 8px !important;
                    font-size: 12px !important; color: #334155 !important;
                    min-height: 40px !important; margin-bottom: 10px !important;
                    word-break: break-all !important; line-height: 1.4 !important;
                }
                .cx-badge {
                    display: inline-block !important; background: #10b981 !important;
                    color: #fff !important; font-size: 10px !important;
                    padding: 1px 5px !important; border-radius: 10px !important; margin-left: 5px !important;
                }
                .cx-btn {
                    width: 100% !important; padding: 6px 0 !important;
                    background: #2563eb !important; color: #fff !important;
                    border: none !important; border-radius: 4px !important;
                    cursor: pointer !important; font-weight: 500 !important;
                    margin-bottom: 6px !important; transition: background .2s !important;
                }
                .cx-btn:hover { background: #1d4ed8 !important; }
                .cx-btn.secondary {
                    background: #f1f5f9 !important; color: #334155 !important;
                    border: 1px solid #cbd5e1 !important;
                }
                .cx-btn.secondary:hover { background: #e2e8f0 !important; }
                .cx-switch {
                    position: relative !important; display: inline-block !important;
                    width: 36px !important; height: 20px !important;
                }
                .cx-switch input { opacity: 0 !important; width: 0 !important; height: 0 !important; }
                .cx-slider {
                    position: absolute !important; cursor: pointer !important;
                    top: 0; left: 0; right: 0; bottom: 0;
                    background-color: #cbd5e1 !important; transition: .3s !important;
                    border-radius: 20px !important;
                }
                .cx-slider:before {
                    position: absolute !important; content: "" !important;
                    height: 14px !important; width: 14px !important;
                    left: 3px !important; bottom: 3px !important;
                    background-color: white !important; transition: .3s !important;
                    border-radius: 50% !important;
                }
                input:checked + .cx-slider { background-color: #2563eb !important; }
                input:checked + .cx-slider:before { transform: translateX(16px) !important; }
                .cx-select {
                    padding: 2px 6px !important; border-radius: 4px !important;
                    border: 1px solid #cbd5e1 !important; font-size: 12px !important; background: #fff !important;
                }
            </style>
            <div id="cx-header">
                <span>📚 超星刷课助手 <span class="cx-badge">v2.1</span></span>
                <span id="cx-minimize" style="cursor:pointer;font-size:16px;">−</span>
            </div>
            <div id="cx-body">
                <div class="cx-status-box" id="cx-status-text">助手已就绪，等待视频/PPT任务...</div>
                <div class="cx-row">
                    <span>自动连播挂机</span>
                    <label class="cx-switch">
                        <input type="checkbox" id="cx-toggle-run" ${config.enabled ? 'checked' : ''}>
                        <span class="cx-slider"></span>
                    </label>
                </div>
                <div class="cx-row">
                    <span>跳过章节测验</span>
                    <label class="cx-switch">
                        <input type="checkbox" id="cx-toggle-quiz" ${config.skipQuiz ? 'checked' : ''}>
                        <span class="cx-slider"></span>
                    </label>
                </div>
                <div class="cx-row">
                    <span>播放倍速</span>
                    <select id="cx-select-speed" class="cx-select">
                        <option value="1.0"  ${config.playbackRate === 1.0  ? 'selected' : ''}>1.0x (安全)</option>
                        <option value="1.25" ${config.playbackRate === 1.25 ? 'selected' : ''}>1.25x</option>
                        <option value="1.5"  ${config.playbackRate === 1.5  ? 'selected' : ''}>1.5x</option>
                        <option value="1.75" ${config.playbackRate === 1.75 ? 'selected' : ''}>1.75x</option>
                        <option value="2.0"  ${config.playbackRate === 2.0  ? 'selected' : ''}>2.0x (最高)</option>
                    </select>
                </div>
                <div class="cx-row">
                    <span>静音播放</span>
                    <label class="cx-switch">
                        <input type="checkbox" id="cx-toggle-mute" ${config.muted ? 'checked' : ''}>
                        <span class="cx-slider"></span>
                    </label>
                </div>
                <button class="cx-btn secondary" id="cx-btn-pip" style="margin-top:4px;">🖼️ 开启画中画</button>
                <button class="cx-btn secondary" id="cx-btn-playnow">▶️ 强制立即起播</button>
                <button class="cx-btn secondary" id="cx-btn-next">⏭️ 手动跳到下一节</button>
            </div>
        `;
        parent.appendChild(box);

        document.getElementById('cx-toggle-run').addEventListener('change', e => {
            config.enabled = e.target.checked;
            saveConfig(config);
            updateStatus(config.enabled ? '自动挂机已开启' : '自动挂机已暂停');
        });
        document.getElementById('cx-toggle-quiz').addEventListener('change', e => {
            config.skipQuiz = e.target.checked;
            saveConfig(config);
        });
        document.getElementById('cx-select-speed').addEventListener('change', e => {
            config.playbackRate = parseFloat(e.target.value);
            saveConfig(config);
            updateStatus(`倍速已调整为 ${config.playbackRate}x`);
        });
        document.getElementById('cx-toggle-mute').addEventListener('change', e => {
            config.muted = e.target.checked;
            saveConfig(config);
        });
        document.getElementById('cx-btn-pip').addEventListener('click', requestPiP);
        document.getElementById('cx-btn-playnow').addEventListener('click', () => {
            triggerPlayAllVideos();
            updateStatus('已触发强制起播');
        });
        document.getElementById('cx-btn-next').addEventListener('click', () => {
            cancelPendingJump();
            markNavigating(5000); // 开启 5 秒保护期，杜绝手动切节后的误判连跳
            lastJumpTime = 0;     // 手动不受冷却阻挡
            goNextChapter();
        });

        let mini = false;
        document.getElementById('cx-minimize').addEventListener('click', () => {
            const body = document.getElementById('cx-body');
            const btn = document.getElementById('cx-minimize');
            mini = !mini;
            body.style.display = mini ? 'none' : 'block';
            btn.innerText = mini ? '+' : '−';
        });

        makeDraggable(box, document.getElementById('cx-header'));
    }

    function updateStatus(msg) {
        log(msg);
        const el = document.getElementById('cx-status-text');
        if (el) el.innerText = msg;
    }

    function formatTime(s) {
        if (!s || isNaN(s)) return '00:00';
        const m = Math.floor(s / 60), sec = Math.floor(s % 60);
        return `${m < 10 ? '0' : ''}${m}:${sec < 10 ? '0' : ''}${sec}`;
    }

    function makeDraggable(panel, handle) {
        let px = 0, py = 0, mx = 0, my = 0;
        handle.onmousedown = e => {
            e.preventDefault();
            mx = e.clientX; my = e.clientY;
            document.onmouseup = () => { document.onmouseup = null; document.onmousemove = null; };
            document.onmousemove = e => {
                e.preventDefault();
                px = mx - e.clientX; py = my - e.clientY;
                mx = e.clientX; my = e.clientY;
                panel.style.top = (panel.offsetTop - py) + 'px';
                panel.style.left = (panel.offsetLeft - px) + 'px';
                panel.style.right = 'auto';
            };
        };
    }

    // ==========================================
    // 11. 视频 Frame 端并发播放与中央协同汇报
    // ==========================================
    const FRAME_ID = 'f_' + Math.random().toString(36).slice(2, 7);
    const localVideosMap = new Map();

    // 检测视频是否对应已经完成的任务点（用于跳过已观看过的视频）
    function isJobAlreadyFinished(video) {
        try {
            // 1. 如果视频本身已被标记
            if (video && video.dataset.isJobFinished === 'true') return true;

            // 2. 视频自身已经播放完毕
            if (video && (video.ended || (video.duration > 3 && video.currentTime >= video.duration - 1.0))) {
                return true;
            }

            // 3. 超星原生全局变量标志（模块页面注入的变量）
            try {
                if (window.isPassed === true || (window.parent && window.parent.isPassed === true)) return true;
                if (window.AttachmentSetting && (window.AttachmentSetting.isPassed === true || window.AttachmentSetting.passed === true)) return true;
                if (window.parent && window.parent.AttachmentSetting && (window.parent.AttachmentSetting.isPassed === true || window.parent.AttachmentSetting.passed === true)) return true;
            } catch (e) {}

            // 4. 检查宿主 iframe 元素及其附件容器（.ans-attach-ct）
            const checkHostFrame = (win) => {
                try {
                    if (!win || !win.frameElement) return false;
                    const frameEl = win.frameElement;

                    // 4.1 检查 iframe 上的 data 属性
                    const dataAttr = frameEl.getAttribute('data') || (frameEl.dataset && frameEl.dataset.data) || '';
                    if (dataAttr && (dataAttr.includes('true') || dataAttr.includes('passed'))) {
                        if (dataAttr.includes('"isPassed":true') || dataAttr.includes("'isPassed':true") ||
                            dataAttr.includes('"passed":true') || dataAttr.includes("'passed':true")) {
                            return true;
                        }
                    }

                    // 4.2 检查附件容器及任务点图标
                    const parentCt = frameEl.closest ? frameEl.closest('.ans-attach-ct') : (frameEl.parentElement ? frameEl.parentElement.closest('.ans-attach-ct') : null);
                    if (parentCt) {
                        if (parentCt.classList.contains('ans-job-finished')) return true;
                        const jobIcon = parentCt.querySelector('.ans-job-icon, [class*="job-icon"]');
                        if (jobIcon) {
                            const cls = jobIcon.className || '';
                            const title = jobIcon.getAttribute('title') || '';
                            if (cls.includes('ans-job-finished') || cls.includes('finished') || title.includes('已完成')) {
                                return true;
                            }
                        }
                    }
                } catch (e) {}
                return false;
            };

            if (checkHostFrame(window) || checkHostFrame(window.parent)) return true;

            // 5. 当前文档内查找任务点图标
            try {
                const icon = document.querySelector('.ans-job-icon.ans-job-finished, .ans-job-finished');
                if (icon) return true;
            } catch (e) {}
        } catch (e) {}

        return false;
    }

    // 监听来自顶层中央调度台的统一播放控制指令
    window.addEventListener('message', (e) => {
        const data = e.data;
        if (!data || data.prefix !== MSG_PREFIX) return;

        if (data.action === 'VIDEO_CONTROL') {
            // 全局并发播放指令：仅对未完成任务点的视频起播，已完成的坚决不播
            localVideosMap.forEach((v) => {
                if (v.dataset.isJobFinished !== 'true' && v.paused && !v.ended) {
                    v.play().catch(() => {
                        const btn = document.querySelector('.vjs-big-play-button, .ans-video-play');
                        if (btn) btn.click();
                    });
                }
            });
        }
    });

    function handleAllVideosInFrame() {
        const videos = document.querySelectorAll('video');
        if (videos.length === 0 || !config.enabled) return;

        videos.forEach((video, idx) => {
            const videoId = video.dataset.cxVid || (video.dataset.cxVid = `${FRAME_ID}_${idx}`);
            localVideosMap.set(videoId, video);

            const alreadyDone = isJobAlreadyFinished(video);
            const isDone = alreadyDone || video.ended || (video.duration && video.duration > 3 && video.currentTime >= video.duration - 1.0);

            if (alreadyDone) {
                video.dataset.isJobFinished = 'true';
            } else {
                if (config.muted && !video.muted) {
                    video.muted = true;
                    video.volume = 0;
                }
                if (config.playbackRate && video.playbackRate !== config.playbackRate) {
                    try { video.playbackRate = config.playbackRate; } catch (e) {}
                }

                // 仅对未完成任务点的视频自动并发起播
                if (!isDone && video.paused && !video.ended) {
                    video.play().catch(() => {
                        const btn = document.querySelector('.vjs-big-play-button, .ans-video-play');
                        if (btn) btn.click();
                    });
                }
            }

            // 定期汇报视频状态给中央调度台
            sendToTop('VIDEO_REPORT', {
                videoId,
                current: alreadyDone ? (video.duration || 1) : (video.currentTime || 0),
                duration: video.duration || 0,
                ended: isDone,
                alreadyFinished: alreadyDone,
                paused: video.paused
            });

            // 监听 ended 和 timeupdate 事件，确保第一时间汇报
            if (!video.dataset.hasReporting) {
                video.dataset.hasReporting = 'true';
                video.addEventListener('ended', () => {
                    sendToTop('VIDEO_REPORT', {
                        videoId,
                        current: video.duration || video.currentTime || 0,
                        duration: video.duration || 0,
                        ended: true,
                        alreadyFinished: true,
                        paused: true
                    });
                });
            }
        });
    }

    // ==========================================
    // 12. PPT/文档自动翻页与任务点滑到底（强力修复版）
    // ==========================================
    let pptDoneUrls = new Set();
    let pptScrolling = false;

    function handlePPTInFrame() {
        if (!config.enabled || pptScrolling) return;

        // 1. 如果当前页面有视频正在播放，坚决不当做 PPT 处理
        const hasVideo = Array.from(document.querySelectorAll('video')).some(
            v => v.duration > 1 && !v.ended
        );
        if (hasVideo || window.location.href.includes('/modules/video/')) return;

        // 2. 检查当前 frame 是否为 PPT/PDF/文档页面
        const isPPT = checkIsPPTPage();
        if (isPPT) {
            const key = window.location.href;
            if (pptDoneUrls.has(key)) return;

            log('已识别到 PPT/文档任务点页面，准备将侧边滑块滑到最底...');
            sendToTop('PPT_FOUND');
            pptScrolling = true;
            autoScrollToBottom(key);
            return;
        }

        // 3. 如果当前是卡片父容器（knowledge/cards），探测子 iframe 是否有 PPT
        handlePPTFromParentFrame();
    }

    // 严谨检测是否为 PPT / PDF / 文档页面
    function checkIsPPTPage() {
        const url = window.location.href.toLowerCase();

        // 排除音视频模块
        if (url.includes('/modules/video/') || url.includes('/modules/audio/')) return false;

        // 命中 URL 特征
        const urlMatch = (
            url.includes('/modules/pdf/') ||
            url.includes('/modules/doc/') ||
            url.includes('/modules/ppt/') ||
            url.includes('/pdfreader/') ||
            url.includes('/readsvr/') ||
            (url.includes('/ananas/') && (url.includes('objectid=') || url.includes('jobid=')))
        );
        if (urlMatch) return true;

        // 命中 DOM 特征（PDF.js 专属容器或超星阅读器）
        const domMatch = !!(
            document.getElementById('viewerContainer') ||     // PDF.js 核心带滑块的滚动容器！
            document.querySelector('#viewer.pdfViewer') ||
            document.querySelector('#outerContainer') ||
            document.getElementById('scroll_div') ||
            document.getElementById('pan-scroll') ||
            document.getElementById('documentContainer') ||
            document.querySelector('.imglook') ||
            document.getElementById('img') ||
            window.PDFViewerApplication ||
            typeof window.finishJob === 'function'
        );
        return domMatch;
    }

    // 获取所有需要滚动的目标容器（核心：#viewerContainer 是超星带滑块的主容器）
    function getScrollContainers() {
        const targets = new Set();
        const primarySelectors = [
            '#viewerContainer',       // 最核心：超星 PDF/PPT 侧边滑块所在的滚动容器
            '#outerContainer',
            '.pdfViewer',
            '#scroll_div',
            '#pan-scroll',
            '#contentbox',
            '#reader',
            '.reader_Wr',
            '#documentContainer',
            '.imglook',
            '#img',
            '.mian-body'
        ];

        primarySelectors.forEach(sel => {
            const el = document.querySelector(sel);
            if (el) targets.add(el);
        });

        // 动态搜寻页面中所有高度超过窗口、有滚动条的 div
        document.querySelectorAll('div').forEach(div => {
            if (div.scrollHeight > div.clientHeight + 40 && div.clientHeight > 100) {
                const ov = window.getComputedStyle(div).overflowY;
                if (ov === 'auto' || ov === 'scroll' || div.id === 'viewerContainer') {
                    targets.add(div);
                }
            }
        });

        targets.add(document.documentElement);
        targets.add(document.body);
        return Array.from(targets);
    }

    function autoScrollToBottom(pageKey) {
        let stepCount = 0;
        const maxSteps = 40;        // 最多逐步滚动 40 步
        const intervalTime = 400;   // 每 400ms 滑动一屏，保证页面有时间触发监听

        const timer = setInterval(() => {
            stepCount++;
            const containers = getScrollContainers();

            // 1. 对所有候选容器进行平滑向下推进
            containers.forEach(el => {
                const step = Math.max(el.clientHeight * 0.85, 400);
                el.scrollTop += step;
                // 必须手动派发 scroll 事件，超星监听器依赖 scroll 事件判断是否到底
                el.dispatchEvent(new Event('scroll', { bubbles: true }));
                if (window.$ && window.$(el).trigger) {
                    try { window.$(el).trigger('scroll'); } catch (e) {}
                }
            });

            // 派发 window/document 级别的全局 scroll 事件
            window.dispatchEvent(new Event('scroll'));

            // 2. 模拟点击翻页按钮（适用于单页点击型 PPT）
            const nextBtns = document.querySelectorAll(
                '[class*="nextPage"], [id*="nextPage"], .next_page, .page-next, [title*="下一页"]'
            );
            nextBtns.forEach(btn => { try { btn.click(); } catch (e) {} });

            // 3. 如果是 PDF.js，直接通过 API 翻到最后一页
            if (window.PDFViewerApplication) {
                try {
                    const pagesCount = window.PDFViewerApplication.pagesCount || 
                                       (window.PDFViewerApplication.pdfViewer && window.PDFViewerApplication.pdfViewer.pagesCount);
                    if (pagesCount) {
                        window.PDFViewerApplication.page = pagesCount;
                        if (window.PDFViewerApplication.pdfViewer) {
                            window.PDFViewerApplication.pdfViewer.currentPageNumber = pagesCount;
                        }
                    }
                } catch (e) {}
            }

            // 4. 判断是否已经有一大半容器滑到底部，或者达到最大步数
            let isAtBottom = false;
            containers.forEach(el => {
                if (el.scrollHeight > el.clientHeight + 20) {
                    const diff = el.scrollHeight - el.scrollTop - el.clientHeight;
                    if (diff <= 30) isAtBottom = true;
                }
            });

            if (isAtBottom || stepCount >= maxSteps) {
                // 最后一击：强制将所有容器直接置到底部最大值
                containers.forEach(el => {
                    el.scrollTop = el.scrollHeight;
                    el.dispatchEvent(new Event('scroll', { bubbles: true }));
                });

                // 尝试调用超星内部自带的任务完成钩子
                try {
                    if (typeof window.finishJob === 'function') window.finishJob();
                    if (typeof window.sendReadLog === 'function') window.sendReadLog();
                    if (typeof window.jProgress === 'function') window.jProgress();
                } catch (e) {}

                clearInterval(timer);
                pptScrolling = false;
                pptDoneUrls.add(pageKey);
                log(`PPT/文档滑块已成功滑动到底部！（历时 ${(stepCount * intervalTime / 1000).toFixed(1)} 秒）`);
                sendToTop('PPT_DONE');
            }
        }, intervalTime);
    }

    // 从父卡片级 frame 向下穿透处理 iframe 内的 PPT
    function handlePPTFromParentFrame() {
        const iframes = document.querySelectorAll('iframe.ans-attach-online, iframe');
        iframes.forEach(f => {
            try {
                const subWin = f.contentWindow;
                const subDoc = f.contentDocument || subWin.document;
                if (!subDoc) return;

                // 检查子 iframe 里是否有 #viewerContainer
                const vc = subDoc.getElementById('viewerContainer') || subDoc.querySelector('.pdfViewer, #reader, #scroll_div');
                if (vc && !f.dataset.pptHandled) {
                    f.dataset.pptHandled = 'true';
                    log('从父框架穿透发现子 iframe 内有 PPT 滑块，正在驱动其滑到底部...');
                    sendToTop('PPT_FOUND');

                    // 驱动子 iframe 内滚动
                    let curStep = 0;
                    const subTimer = setInterval(() => {
                        curStep++;
                        vc.scrollTop += Math.max(vc.clientHeight * 0.85, 400);
                        vc.dispatchEvent(new Event('scroll', { bubbles: true }));

                        if (curStep >= 25 || vc.scrollTop + vc.clientHeight >= vc.scrollHeight - 20) {
                            vc.scrollTop = vc.scrollHeight;
                            vc.dispatchEvent(new Event('scroll', { bubbles: true }));
                            clearInterval(subTimer);
                            try { if (typeof subWin.finishJob === 'function') subWin.finishJob(); } catch (e) {}
                            log('子 iframe PPT 滑动到底部完成');
                            sendToTop('PPT_DONE');
                        }
                    }, 400);
                }
            } catch (e) {
                // 跨域忽略
            }
        });
    }

    // ==========================================
    // 13. 画中画与辅助功能
    // ==========================================
    function requestPiP() {
        let video = document.querySelector('video');
        if (!video) {
            document.querySelectorAll('iframe').forEach(f => {
                try {
                    const v = f.contentDocument && f.contentDocument.querySelector('video');
                    if (v) video = v;
                } catch (e) {}
            });
        }
        if (!video || !document.pictureInPictureEnabled) return;
        if (document.pictureInPictureElement) {
            document.exitPictureInPicture();
        } else {
            video.requestPictureInPicture().catch(() => {});
        }
    }

    function triggerPlayAllVideos() {
        document.querySelectorAll('video').forEach(v => {
            v.muted = true;
            v.volume = 0;
            v.play().catch(() => {});
        });
        document.querySelectorAll('.vjs-big-play-button, .ans-video-play').forEach(b => b.click());
    }

    // ==========================================
    // 14. 章节测验与弹题处理
    // ==========================================
    function handleQuizInFrame() {
        if (!config.skipQuiz || !config.enabled) return;
        const isQuiz = document.querySelector('.ZyTop, .TiMu, #submitCommit, .pattern-work, .TiMu-head');
        if (isQuiz && !window._cx_quiz_skip_sent) {
            window._cx_quiz_skip_sent = true;
            log('检测到测验页面，发送跳过通知');
            sendToTop('QUIZ_SKIPPED');
        }
    }

    function handlePopupQuizInFrame() {
        const quizBox = document.querySelector('.ans-videoquiz, .ans-videoquiz-title, #videoquiz-pop');
        if (!quizBox) return;
        const opts = quizBox.querySelectorAll('input[type="radio"], input[type="checkbox"]');
        if (opts.length > 0) opts[0].click();
        setTimeout(() => {
            const submit = quizBox.querySelector('.ans-videoquiz-submit, button[type="submit"], .btn-submit, input[value*="提交"]');
            if (submit) {
                submit.click();
                sendToTop('POPUP_QUIZ_HANDLED');
            }
        }, 600);
    }

})();
