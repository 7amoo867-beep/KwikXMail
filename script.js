
"use strict";

// ======================================================
// KwikX Mail — Frontend
// Temporary email service using the Mail.tm API
// ======================================================

const API_BASE = "https://api.mail.tm";
const POLLING_INTERVAL_MS = 5000;
const REQUEST_TIMEOUT_MS = 12000;

let currentLang = document.documentElement.lang || "en";
let currentAccount = null;
let currentToken = null;
let pollingInterval = null;
let availableDomains = [];

let isCreatingAccount = false;
let isFetchingMessages = false;
let lastRenderedSignature = "";
let lastPollingErrorAt = 0;
let accountGeneration = 0;


// ======================================================
// General Helpers
// ======================================================

class ApiError extends Error {
    constructor(message, status = 0, payload = null) {
        super(message);
        this.name = "ApiError";
        this.status = status;
        this.payload = payload;
    }
}

function getText(ar, en) {
    return currentLang === "ar" ? ar : en;
}

function getElement(id) {
    return document.getElementById(id);
}

function randomHex(byteCount = 24) {
    if (!window.crypto || !window.crypto.getRandomValues) {
        throw new Error("secure_random_unavailable");
    }

    const bytes = new Uint8Array(byteCount);
    window.crypto.getRandomValues(bytes);

    return Array.from(bytes)
        .map(byte => byte.toString(16).padStart(2, "0"))
        .join("");
}

function createUsername() {
    return "kwik" + randomHex(8);
}

function createPassword() {
    // A new, unpredictable password for each temporary account.
    // It is not stored in localStorage or sessionStorage.
    return randomHex(24) + "Kx!";
}

function getApiErrorMessage(error) {
    if (error && error.name === "AbortError") {
        return getText(
            "انتهت مهلة الاتصال بالخدمة. حاول مرة أخرى.",
            "The request timed out. Please try again."
        );
    }

    if (error && error.status === 401) {
        return getText(
            "انتهت صلاحية الجلسة أو أن بيانات الدخول غير صالحة. جرّب إنشاء بريد جديد.",
            "The session is invalid or expired. Try generating a new email."
        );
    }

    if (error && error.status === 403) {
        return getText(
            "الخدمة رفضت الطلب. حاول لاحقًا.",
            "The service rejected the request. Please try again later."
        );
    }

    if (error && error.status === 404) {
        return getText(
            "العنصر المطلوب لم يعد متاحًا.",
            "The requested item is no longer available."
        );
    }

    if (error && error.status === 422) {
        return getText(
            "تعذر إنشاء البريد بهذه البيانات. حاول مرة أخرى.",
            "The email could not be created with these details. Please try again."
        );
    }

    if (error && error.status === 429) {
        return getText(
            "طلبات كثيرة في وقت قصير. انتظر قليلًا ثم حاول مرة أخرى.",
            "Too many requests. Wait a moment and try again."
        );
    }

    if (error && error.status >= 500) {
        return getText(
            "خدمة البريد تواجه مشكلة مؤقتة. حاول بعد قليل.",
            "The email service is temporarily unavailable. Please try again shortly."
        );
    }

    if (error && error.message === "secure_random_unavailable") {
        return getText(
            "المتصفح لا يوفر توليدًا آمنًا للأرقام العشوائية. افتح الموقع عبر اتصال HTTPS.",
            "Secure random generation is unavailable. Open the site over HTTPS."
        );
    }

    return getText(
        "حدث خطأ أثناء الاتصال بالخدمة. تحقق من الإنترنت وحاول مرة أخرى.",
        "A connection error occurred. Check your internet connection and try again."
    );
}


// ======================================================
// API Requests
// ======================================================

async function apiRequest(path, options = {}) {
    const controller = new AbortController();

    const timeoutId = setTimeout(
        () => controller.abort(),
        REQUEST_TIMEOUT_MS
    );

    const headers = {
        "Accept": "application/json",
        ...(options.headers || {})
    };

    if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
    }

    if (options.token) {
        headers["Authorization"] = `Bearer ${options.token}`;
    }

    const requestOptions = {
        method: options.method || "GET",
        headers,
        signal: controller.signal
    };

    if (options.body !== undefined) {
        requestOptions.body = JSON.stringify(options.body);
    }

    try {
        const response = await fetch(
            `${API_BASE}${path}`,
            requestOptions
        );

        let payload = null;

        if (response.status !== 204) {
            const contentType = response.headers.get("content-type") || "";

            if (contentType.includes("application/json")) {
                try {
                    payload = await response.json();
                } catch {
                    payload = null;
                }
            }
        }

        if (!response.ok) {
            throw new ApiError(
                "api_request_failed",
                response.status,
                payload
            );
        }

        return {
            data: payload,
            status: response.status
        };
    } finally {
        clearTimeout(timeoutId);
    }
}


// ======================================================
// Domains
// ======================================================

async function getDomains() {
    const result = await apiRequest("/domains");

    const members = result.data &&
        Array.isArray(result.data["hydra:member"])
        ? result.data["hydra:member"]
        : [];

    const domains = members.filter(domain => {
        return (
            domain &&
            typeof domain.domain === "string" &&
            domain.domain.length > 0 &&
            domain.isActive !== false &&
            domain.isPrivate !== true
        );
    });

    if (domains.length === 0) {
        throw new Error("no_available_domains");
    }

    return domains;
}

async function populateDomains() {
    const select = getElement("domainSelect");

    if (!select) {
        throw new Error("domain_select_missing");
    }

    select.disabled = true;

    availableDomains = await getDomains();

    select.replaceChildren();

    availableDomains.forEach(domain => {
        const option = document.createElement("option");

        option.value = "@" + domain.domain;
        option.textContent = "@" + domain.domain;

        select.appendChild(option);
    });

    updateFullEmail();
}


// ======================================================
// Inbox Status and Controls
// ======================================================

function setInboxStatus(ar, en, busy = false) {
    const inbox = getElement("inboxMessages");

    if (!inbox) return;

    const message = document.createElement("span");

    message.className = "t";
    message.dataset.ar = ar;
    message.dataset.en = en;
    message.textContent = getText(ar, en);

    inbox.replaceChildren(message);
    inbox.setAttribute("aria-busy", busy ? "true" : "false");

    lastRenderedSignature = "";
}

function setMainControlsDisabled(disabled) {
    document
        .querySelectorAll(".buttons-container button")
        .forEach(button => {
            button.disabled = disabled;
        });
}

function stopPolling() {
    if (pollingInterval !== null) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }

    isFetchingMessages = false;
}

function startPolling() {
    stopPolling();

    if (!currentToken || !currentAccount) {
        return;
    }

    fetchMessages();

    pollingInterval = setInterval(() => {
        fetchMessages();
    }, POLLING_INTERVAL_MS);
}


// ======================================================
// Create Temporary Account
// ======================================================

async function createAccount() {
    if (isCreatingAccount) {
        return;
    }

    isCreatingAccount = true;

    const previousAccount = currentAccount;
    const previousToken = currentToken;

    stopPolling();
    setMainControlsDisabled(true);

    let newAccount = null;
    let newToken = null;

    try {
        if (availableDomains.length === 0) {
            await populateDomains();
        }

        const domainNames = availableDomains.map(item => item.domain);

        let lastCreateError = null;

        // Retry with a new username if the generated address is rejected.
        for (let attempt = 0; attempt < 3; attempt++) {
            const username = createUsername();
            const password = createPassword();

            const domain = domainNames[
                Math.floor(Math.random() * domainNames.length)
            ];

            const address = `${username}@${domain}`;

            try {
                const createResult = await apiRequest("/accounts", {
                    method: "POST",
                    body: {
                        address,
                        password
                    }
                });

                const account = createResult.data;

                if (
                    !account ||
                    !account.id ||
                    !account.address
                ) {
                    throw new Error("invalid_account_response");
                }

                const tokenResult = await apiRequest("/token", {
                    method: "POST",
                    body: {
                        address: account.address,
                        password
                    }
                });

                const token = tokenResult.data &&
                    tokenResult.data.token;

                if (!token) {
                    // Best effort cleanup if the provider created the
                    // account but did not return a usable token.
                    throw new Error("token_missing");
                }

                newAccount = account;
                newToken = token;
                break;
            } catch (error) {
                lastCreateError = error;

                // A rejected username may be a collision, but other
                // failures should not be retried repeatedly.
                if (
                    error instanceof ApiError &&
                    error.status === 422 &&
                    attempt < 2
                ) {
                    continue;
                }

                throw error;
            }
        }

        if (!newAccount || !newToken) {
            throw lastCreateError || new Error("account_creation_failed");
        }

        // When replacing an existing inbox, attempt to delete the old
        // provider account before discarding the old token.
        let oldAccountDeleted = true;

        if (
            previousAccount &&
            previousAccount.id &&
            previousToken
        ) {
            try {
                await apiRequest(
                    `/accounts/${encodeURIComponent(previousAccount.id)}`,
                    {
                        method: "DELETE",
                        token: previousToken
                    }
                );
            } catch (error) {
                oldAccountDeleted = false;
                console.warn(
                    "The previous provider account could not be deleted.",
                    error
                );
            }
        }

        currentAccount = newAccount;
        currentToken = newToken;
        accountGeneration++;

        const emailParts = newAccount.address.split("@");
        const username = emailParts[0] || "";
        const domain = emailParts[1] || "";

        const emailInput = getElement("emailName");
        const domainSelect = getElement("domainSelect");
        const hiddenEmail = getElement("fullEmailHidden");

        if (emailInput) {
            emailInput.value = username;
            emailInput.placeholder = "";
        }

        if (domainSelect) {
            const desiredValue = "@" + domain;

            let optionExists = Array.from(domainSelect.options).some(
                option => option.value === desiredValue
            );

            if (!optionExists) {
                const option = document.createElement("option");
                option.value = desiredValue;
                option.textContent = desiredValue;
                domainSelect.appendChild(option);
            }

            domainSelect.value = desiredValue;
        }

        if (hiddenEmail) {
            hiddenEmail.value = newAccount.address;
        }

        lastRenderedSignature = "";

        showToast(
            getText(
                "تم إنشاء البريد المؤقت بنجاح.",
                "Temporary email created successfully."
            ),
            "success"
        );

        if (!oldAccountDeleted) {
            showToast(
                getText(
                    "تم إنشاء البريد الجديد، لكن تعذر تأكيد حذف البريد السابق من مزود الخدمة.",
                    "The new inbox is ready, but deletion of the previous provider account could not be confirmed."
                ),
                "error"
            );
        }

        startPolling();
    } catch (error) {
        console.error("Account creation failed:", error);

        // Preserve the previous inbox when account creation fails.
        currentAccount = previousAccount;
        currentToken = previousToken;

        if (currentToken && currentAccount) {
            startPolling();
        } else {
            currentAccount = null;
            currentToken = null;

            const emailInput = getElement("emailName");
            const hiddenEmail = getElement("fullEmailHidden");

            if (emailInput) {
                emailInput.value = "";
                emailInput.placeholder = getText(
                    "تعذر إنشاء البريد",
                    "Could not create email"
                );
            }

            if (hiddenEmail) {
                hiddenEmail.value = "";
            }

            setInboxStatus(
                "تعذر إنشاء البريد حاليًا. حاول مرة أخرى.",
                "The email could not be created right now. Please try again."
            );
        }

        showToast(getApiErrorMessage(error), "error");
    } finally {
        isCreatingAccount = false;
        setMainControlsDisabled(false);
    }
}


// ======================================================
// Generate a New Address
// ======================================================

function generateNewEmail() {
    if (isCreatingAccount) {
        return;
    }

    if (currentAccount && currentToken) {
        const confirmed = window.confirm(
            getText(
                "إنشاء بريد جديد؟ سنحاول حذف البريد الحالي من مزود الخدمة. إذا فشل الحذف، فقد تظل بياناته موجودة لدى المزود.",
                "Create a new email? We will attempt to delete the current provider account. If deletion fails, the provider may retain it."
            )
        );

        if (!confirmed) {
            return;
        }
    }

    createAccount();
}


// ======================================================
// Fetch and Render Messages
// ======================================================

async function fetchMessages(options = {}) {
    const manual = options.manual === true;

    if (!currentToken || !currentAccount) {
        if (manual) {
            showToast(
                getText(
                    "أنشئ بريدًا مؤقتًا أولًا.",
                    "Generate an email address first."
                ),
                "error"
            );
        }

        return false;
    }

    if (isFetchingMessages) {
        return false;
    }

    isFetchingMessages = true;

    const requestToken = currentToken;
    const requestAccountId = currentAccount.id;

    const inbox = getElement("inboxMessages");

    if (inbox) {
        inbox.setAttribute("aria-busy", "true");
    }

    try {
        const result = await apiRequest("/messages", {
            token: requestToken
        });

        // Ignore responses from an inbox that is no longer active.
        if (
            currentToken !== requestToken ||
            !currentAccount ||
            currentAccount.id !== requestAccountId
        ) {
            return false;
        }

        const messages = result.data &&
            Array.isArray(result.data["hydra:member"])
            ? result.data["hydra:member"]
            : [];

        renderMessages(messages);

        if (manual) {
            showToast(
                getText("تم تحديث صندوق الوارد.", "Inbox refreshed."),
                "success"
            );
        }

        lastPollingErrorAt = 0;
        return true;
    } catch (error) {
        console.error("Fetching messages failed:", error);

        if (
            currentToken !== requestToken ||
            !currentAccount ||
            currentAccount.id !== requestAccountId
        ) {
            return false;
        }

        if (error && error.status === 401) {
            stopPolling();
        }

        const now = Date.now();

        // Avoid flooding users with repeated errors during polling.
        if (manual || now - lastPollingErrorAt > 30000) {
            showToast(getApiErrorMessage(error), "error");
            lastPollingErrorAt = now;
        }

        return false;
    } finally {
        isFetchingMessages = false;

        if (
            currentToken === requestToken &&
            getElement("inboxMessages")
        ) {
            getElement("inboxMessages").setAttribute(
                "aria-busy",
                "false"
            );
        }
    }
}

function renderMessages(messages) {
    const inbox = getElement("inboxMessages");

    if (!inbox) return;

    if (!messages.length) {
        setInboxStatus(
            "الصندوق فارغ حاليًا. في انتظار رسائل جديدة...",
            "Inbox is empty. Waiting for new messages..."
        );
        return;
    }

    // Prevent needlessly rebuilding the inbox every polling cycle.
    const signature = JSON.stringify(
        messages.map(message => ({
            id: message.id,
            subject: message.subject,
            intro: message.intro,
            from: message.from,
            updatedAt: message.updatedAt
        }))
    );

    if (signature === lastRenderedSignature) {
        return;
    }

    lastRenderedSignature = signature;

    const fragment = document.createDocumentFragment();

    messages.forEach(message => {
        const item = document.createElement("div");

        item.className = "message-item";
        item.style.cssText = [
            "background:#1f1f1f",
            "padding:12px",
            "margin:8px 0",
            "border-radius:8px",
            "border-inline-start:4px solid #00cc88",
            "width:100%",
            "box-sizing:border-box",
            "text-align:start",
            "overflow-wrap:anywhere"
        ].join(";");

        const sender = document.createElement("strong");
        const from = message.from || {};

        sender.textContent = from.name || from.address || "Unknown sender";

        const subject = document.createElement("div");
        subject.style.cssText = "color:#aaa; margin-top:5px;";

        subject.textContent = message.subject ||
            getText("بدون عنوان", "No subject");

        const intro = document.createElement("p");
        intro.style.cssText =
            "margin:8px 0; font-size:.95rem; color:#ddd; overflow-wrap:anywhere;";

        intro.textContent = message.intro || "";

        const button = document.createElement("button");

        button.type = "button";
        button.style.cssText = [
            "background:#00cc88",
            "color:#000",
            "border:none",
            "padding:8px 14px",
            "border-radius:4px",
            "cursor:pointer",
            "font-weight:bold"
        ].join(";");

        const buttonLabel = document.createElement("span");
        buttonLabel.className = "t";
        buttonLabel.dataset.ar = "عرض الرسالة";
        buttonLabel.dataset.en = "View message";
        buttonLabel.textContent = getText("عرض الرسالة", "View message");

        button.appendChild(buttonLabel);

        button.addEventListener("click", () => {
            viewMessage(message.id);
        });

        item.appendChild(sender);
        item.appendChild(subject);
        item.appendChild(intro);
        item.appendChild(button);

        if (message.createdAt) {
            const date = document.createElement("small");

            date.style.cssText =
                "display:block; margin-top:8px; color:#888;";

            const parsedDate = new Date(message.createdAt);

            if (!Number.isNaN(parsedDate.getTime())) {
                date.textContent = new Intl.DateTimeFormat(
                    currentLang === "ar" ? "ar" : "en",
                    {
                        dateStyle: "medium",
                        timeStyle: "short"
                    }
                ).format(parsedDate);

                item.appendChild(date);
            }
        }

        fragment.appendChild(item);
    });

    inbox.replaceChildren(fragment);
    inbox.setAttribute("aria-busy", "false");
}


// ======================================================
// View a Message Safely
// ======================================================

function messageHtmlToText(htmlContent) {
    const html = Array.isArray(htmlContent)
        ? htmlContent.join("\n")
        : String(htmlContent || "");

    const parsedDocument = new DOMParser().parseFromString(
        html,
        "text/html"
    );

    // Remove non-message content before extracting plain text.
    parsedDocument
        .querySelectorAll("script, style, iframe, object, embed")
        .forEach(element => element.remove());

    return parsedDocument.body.textContent || "";
}

function showMessageDialog(message) {
    // Remove an existing dialog if one is still open.
    const existingDialog = getElement("kwikMessageDialog");

    if (existingDialog) {
        existingDialog.remove();
    }

    const dialog = document.createElement("dialog");

    dialog.id = "kwikMessageDialog";
    dialog.setAttribute("aria-labelledby", "kwikMessageSubject");

    dialog.style.cssText = [
        "width:min(760px,92vw)",
        "max-height:85vh",
        "padding:22px",
        "border:1px solid #333",
        "border-radius:12px",
        "background:#151515",
        "color:#f5f5f5",
        "box-sizing:border-box",
        "overflow:auto"
    ].join(";");

    const heading = document.createElement("h2");

    heading.id = "kwikMessageSubject";
    heading.style.cssText = "margin:0 0 12px; overflow-wrap:anywhere;";
    heading.textContent = message.subject ||
        getText("بدون عنوان", "No subject");

    const sender = document.createElement("p");

    sender.style.cssText = "color:#aaa; overflow-wrap:anywhere;";

    const from = message.from || {};

    sender.textContent = getText("من: ", "From: ") +
        (from.name || from.address || "Unknown sender");

    const content = document.createElement("pre");

    content.style.cssText = [
        "white-space:pre-wrap",
        "overflow-wrap:anywhere",
        "font:inherit",
        "line-height:1.6",
        "max-height:55vh",
        "overflow:auto",
        "background:#202020",
        "padding:14px",
        "border-radius:8px",
        "color:#eee"
    ].join(";");

    const plainText = message.text ||
        messageHtmlToText(message.html) ||
        message.intro ||
        getText("لا يوجد محتوى نصي متاح.", "No message text is available.");

    content.textContent = plainText;

    const closeButton = document.createElement("button");

    closeButton.type = "button";
    closeButton.textContent = getText("إغلاق", "Close");
    closeButton.style.cssText = [
        "background:#00cc88",
        "color:#000",
        "border:none",
        "border-radius:6px",
        "padding:10px 18px",
        "font-weight:bold",
        "cursor:pointer"
    ].join(";");

    closeButton.addEventListener("click", () => {
        if (dialog.open && typeof dialog.close === "function") {
            dialog.close();
        } else {
            dialog.remove();
        }
    });

    dialog.appendChild(heading);
    dialog.appendChild(sender);
    dialog.appendChild(content);
    dialog.appendChild(closeButton);

    dialog.addEventListener("click", event => {
        if (event.target === dialog && dialog.open) {
            dialog.close();
        }
    });

    dialog.addEventListener("close", () => {
        dialog.remove();
    }, { once: true });

    document.body.appendChild(dialog);

    if (typeof dialog.showModal === "function") {
        dialog.showModal();
    } else {
        dialog.setAttribute("open", "");
        dialog.style.position = "fixed";
        dialog.style.inset = "5vh auto auto 50%";
        dialog.style.transform = "translateX(-50%)";
        dialog.style.zIndex = "99999";
    }
}

async function viewMessage(id) {
    if (!currentToken || !currentAccount || !id) {
        return;
    }

    const requestToken = currentToken;
    const requestAccountId = currentAccount.id;

    try {
        const result = await apiRequest(
            `/messages/${encodeURIComponent(id)}`,
            { token: requestToken }
        );

        if (
            currentToken !== requestToken ||
            !currentAccount ||
            currentAccount.id !== requestAccountId
        ) {
            return;
        }

        const message = result.data;

        if (!message || !message.id) {
            throw new Error("invalid_message_response");
        }

        showMessageDialog(message);

        // Mark as read where supported. Failure does not prevent viewing.
        apiRequest(`/messages/${encodeURIComponent(id)}`, {
            method: "PATCH",
            token: requestToken
        }).catch(error => {
            console.warn("Could not mark message as read:", error);
        });
    } catch (error) {
        console.error("Opening message failed:", error);

        showToast(getApiErrorMessage(error), "error");
    }
}


// ======================================================
// Manual Refresh
// ======================================================

async function manualRefresh() {
    const icon = getElement("refreshIcon");

    if (!currentToken || !currentAccount) {
        showToast(
            getText(
                "أنشئ بريدًا مؤقتًا أولًا.",
                "Generate an email address first."
            ),
            "error"
        );
        return;
    }

    if (icon) {
        icon.classList.add("fa-spin");
    }

    try {
        await fetchMessages({ manual: true });
    } finally {
        setTimeout(() => {
            if (icon) {
                icon.classList.remove("fa-spin");
            }
        }, 500);
    }
}


// ======================================================
// Clear the Current Inbox from This Page
// ======================================================

function deleteEmail() {
    // This button clears local page access; it does not promise
    // server-side deletion. Replacing an inbox uses a separate
    // deletion attempt through the provider API.

    accountGeneration++;

    stopPolling();

    currentAccount = null;
    currentToken = null;
    lastRenderedSignature = "";

    const emailInput = getElement("emailName");
    const hiddenEmail = getElement("fullEmailHidden");

    if (emailInput) {
        emailInput.value = "";
        emailInput.placeholder = getText(
            "أنشئ بريدًا جديدًا",
            "Generate a new email"
        );
    }

    if (hiddenEmail) {
        hiddenEmail.value = "";
    }

    setInboxStatus(
        "تم مسح البريد من الصفحة. يمكنك إنشاء بريد جديد.",
        "The inbox was cleared from this page. You can generate a new email."
    );

    showToast(
        getText(
            "تم مسح البريد من الصفحة.",
            "The inbox was cleared from this page."
        ),
        "success"
    );
}


// ======================================================
// Copy Email
// ======================================================

async function copyEmail() {
    const hiddenEmail = getElement("fullEmailHidden");
    const email = hiddenEmail ? hiddenEmail.value.trim() : "";

    if (!email) {
        showToast(
            getText(
                "لا يوجد بريد لنسخه. أنشئ بريدًا أولًا.",
                "There is no email address to copy. Generate one first."
            ),
            "error"
        );
        return;
    }

    try {
        if (
            navigator.clipboard &&
            typeof navigator.clipboard.writeText === "function"
        ) {
            await navigator.clipboard.writeText(email);
        } else {
            const temporaryInput = document.createElement("textarea");

            temporaryInput.value = email;
            temporaryInput.setAttribute("readonly", "");
            temporaryInput.style.position = "fixed";
            temporaryInput.style.opacity = "0";

            document.body.appendChild(temporaryInput);
            temporaryInput.select();

            const copied = document.execCommand("copy");
            temporaryInput.remove();

            if (!copied) {
                throw new Error("clipboard_copy_failed");
            }
        }

        showToast(
            getText("تم نسخ عنوان البريد.", "Email address copied."),
            "success"
        );
    } catch (error) {
        console.error("Copy failed:", error);

        showToast(
            getText(
                "تعذر النسخ تلقائيًا. حاول نسخ العنوان يدويًا.",
                "Automatic copying failed. Please copy the address manually."
            ),
            "error"
        );
    }
}


// ======================================================
// Toast Notifications
// ======================================================

function showToast(message, type = "success") {
    const toast = document.createElement("div");

    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");

    toast.style.cssText = [
        "position:fixed",
        "top:20px",
        "left:50%",
        "transform:translateX(-50%)",
        "padding:14px 22px",
        "border-radius:8px",
        "color:#fff",
        "z-index:999999",
        "font-weight:600",
        "box-shadow:0 4px 15px rgba(0,0,0,.3)",
        "max-width:90vw",
        "box-sizing:border-box",
        "text-align:center",
        "line-height:1.5",
        "background:" + (type === "success" ? "#008f62" : "#b83232")
    ].join(";");

    toast.textContent = message;

    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.transition = "opacity .3s";
        toast.style.opacity = "0";

        setTimeout(() => {
            toast.remove();
        }, 350);
    }, 3000);
}


// ======================================================
// Articles
// ======================================================

function toggleArticle(element) {
    if (!element) return;

    const wasActive = element.classList.contains("active");

    document.querySelectorAll(".art-box").forEach(box => {
        box.classList.remove("active");
        box.setAttribute("aria-expanded", "false");
    });

    if (!wasActive) {
        element.classList.add("active");
        element.setAttribute("aria-expanded", "true");
    }
}


// ======================================================
// Language Switching
// ======================================================

function switchLanguage(lang) {
    if (lang !== "en" && lang !== "ar") {
        return;
    }

    currentLang = lang;

    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";

    const currentLanguageText = getElement("currentLangText");

    if (currentLanguageText) {
        currentLanguageText.textContent =
            lang === "ar" ? "العربية" : "English";
    }

    document.querySelectorAll(".t").forEach(element => {
        const translatedText = element.getAttribute(`data-${lang}`);

        if (translatedText !== null) {
            // Use textContent so translations are not interpreted as HTML.
            element.textContent = translatedText;
        }
    });
}


// ======================================================
// Email Address Display
// ======================================================

function updateFullEmail() {
    const hiddenEmail = getElement("fullEmailHidden");

    // The displayed address must always match the actual API account.
    // Do not construct a fake address from independently edited fields.
    if (hiddenEmail) {
        hiddenEmail.value = (
            currentAccount &&
            currentAccount.address &&
            currentToken
        )
            ? currentAccount.address
            : "";
    }
}


// ======================================================
// Mail.tm Attribution
// ======================================================

function ensureMailTmAttribution() {
    const footer = document.querySelector("footer");

    if (!footer || footer.querySelector("[data-mailtm-attribution]")) {
        return;
    }

    const paragraph = document.createElement("p");

    paragraph.dataset.mailtmAttribution = "true";
    paragraph.style.cssText =
        "margin-top:12px; font-size:.85rem; opacity:.75;";

    const label = document.createElement("span");

    label.className = "t";
    label.dataset.ar = "خدمة البريد المؤقت مقدمة عبر ";
    label.dataset.en = "Temporary email service powered by ";
    label.textContent = getText(
        "خدمة البريد المؤقت مقدمة عبر ",
        "Temporary email service powered by "
    );

    const link = document.createElement("a");

    link.href = "https://mail.tm/";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Mail.tm";

    paragraph.appendChild(label);
    paragraph.appendChild(link);

    const footerLinks = footer.lastElementChild;

    if (footerLinks) {
        footer.insertBefore(paragraph, footerLinks);
    } else {
        footer.appendChild(paragraph);
    }
}


// ======================================================
// Initialize Application
// ======================================================

async function initializeApp() {
    // Match the initial HTML language.
    switchLanguage(document.documentElement.lang || "en");

    ensureMailTmAttribution();

    setInboxStatus(
        "جاري تجهيز صندوق البريد...",
        "Preparing your inbox...",
        true
    );

    try {
        await populateDomains();
        await createAccount();
    } catch (error) {
        console.error("Application initialization failed:", error);

        setInboxStatus(
            "تعذر تجهيز الخدمة حاليًا. حدّث الصفحة أو حاول مرة أخرى.",
            "The service could not be initialized. Refresh the page or try again."
        );

        showToast(getApiErrorMessage(error), "error");
    }
}

document.addEventListener("DOMContentLoaded", initializeApp);
