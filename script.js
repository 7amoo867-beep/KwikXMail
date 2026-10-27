"use strict";

// ======================================================
// KwikX Mail — Frontend
// Uses DummyInbox's documented, browser-compatible API.
// API docs: https://dummyinbox.com/api
// ======================================================

const API_BASE = "https://dummyinbox.com/api/v1";
const POLLING_INTERVAL_MS = 10000;
const REQUEST_TIMEOUT_MS = 12000;

let currentLang = document.documentElement.lang || "en";
let currentAccount = null;
let pollingInterval = null;
let availableDomains = [];

let isCreatingAccount = false;
let isFetchingMessages = false;
let lastRenderedSignature = "";
let lastPollingErrorAt = 0;


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

function getApiErrorMessage(error) {
    if (error && error.name === "AbortError") {
        return getText(
            "انتهت مهلة الاتصال بخدمة البريد. حاول مرة أخرى.",
            "The mail service request timed out. Please try again."
        );
    }

    if (error && error.status === 400) {
        return getText(
            "الطلب غير صالح. حدّث الصفحة وحاول مرة أخرى.",
            "The request was invalid. Refresh the page and try again."
        );
    }

    if (error && error.status === 403) {
        return getText(
            "الخدمة رفضت الطلب. جرّب عنوانًا جديدًا أو حاول لاحقًا.",
            "The service rejected the request. Try a new address or try again later."
        );
    }

    if (error && error.status === 404) {
        return getText(
            "الرسالة غير موجودة أو انتهت صلاحيتها.",
            "The message was not found or has expired."
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
            "The mail service is temporarily unavailable. Please try again shortly."
        );
    }

    if (error && error.message === "no_available_domains") {
        return getText(
            "لا توجد نطاقات بريد متاحة حاليًا.",
            "No email domains are currently available."
        );
    }

    if (error instanceof TypeError) {
        return getText(
            "تعذر الاتصال بخدمة البريد. قد تكون الخدمة غير متاحة مؤقتًا.",
            "Could not connect to the mail service. It may be temporarily unavailable."
        );
    }

    return getText(
        "حدث خطأ أثناء الاتصال بخدمة البريد. حاول مرة أخرى.",
        "A mail service error occurred. Please try again."
    );
}


// ======================================================
// API Requests
// ======================================================

async function apiRequest(path, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const headers = {
        "Accept": "application/json",
        ...(options.headers || {})
    };

    const requestOptions = {
        method: options.method || "GET",
        headers,
        signal: controller.signal,
        cache: "no-store"
    };

    if (options.body !== undefined) {
        headers["Content-Type"] = "application/json";
        requestOptions.body = JSON.stringify(options.body);
    }

    try {
        const response = await fetch(`${API_BASE}${path}`, requestOptions);
        let payload = null;
        const contentType = response.headers.get("content-type") || "";

        if (response.status !== 204) {
            if (contentType.includes("application/json")) {
                try {
                    payload = await response.json();
                } catch {
                    payload = null;
                }
            } else {
                const responseText = await response.text().catch(() => "");
                payload = responseText ? { message: responseText } : null;
            }
        }

        if (!response.ok) {
            const providerMessage =
                payload && typeof payload.error === "string"
                    ? payload.error
                    : payload && payload.error && payload.error.message
                        ? payload.error.message
                        : "api_request_failed";

            throw new ApiError(providerMessage, response.status, payload);
        }

        return { data: payload, status: response.status };
    } finally {
        clearTimeout(timeoutId);
    }
}


// ======================================================
// Domains
// ======================================================

async function getDomains() {
    const result = await apiRequest("/domains");
    const list = result.data && Array.isArray(result.data.domains)
        ? result.data.domains
        : [];

    const domains = list
        .filter(domain => typeof domain === "string" && domain.trim())
        .map(domain => ({ domain: domain.trim().toLowerCase() }));

    if (!domains.length) {
        throw new Error("no_available_domains");
    }

    return domains;
}

async function populateDomains() {
    const select = getElement("domainSelect");
    if (!select) throw new Error("domain_select_missing");

    select.disabled = true;
    availableDomains = await getDomains();
    select.replaceChildren();

    for (const item of availableDomains) {
        const option = document.createElement("option");
        option.value = `@${item.domain}`;
        option.textContent = `@${item.domain}`;
        select.appendChild(option);
    }

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
    document.querySelectorAll(".buttons-container button").forEach(button => {
        button.disabled = disabled;
    });
}

function stopPolling() {
    if (pollingInterval !== null) {
        clearInterval(pollingInterval);
        pollingInterval = null;
    }
    // Do not reset isFetchingMessages here. An earlier network request may
    // still be pending; its finally block will clear the flag when it ends.
}

function startPolling() {
    stopPolling();
    if (!currentAccount || !currentAccount.address) return;

    fetchMessages();
    pollingInterval = setInterval(fetchMessages, POLLING_INTERVAL_MS);
}


// ======================================================
// Create Temporary Address
// ======================================================

async function createAccount() {
    if (isCreatingAccount) return;

    isCreatingAccount = true;
    const previousAccount = currentAccount;

    stopPolling();
    setMainControlsDisabled(true);

    try {
        if (availableDomains.length === 0) {
            await populateDomains();
        }

        const selectedValue = getElement("domainSelect")?.value || "";
        const selectedDomain = selectedValue.startsWith("@")
            ? selectedValue.slice(1)
            : selectedValue;
        const domain = availableDomains.some(item => item.domain === selectedDomain)
            ? selectedDomain
            : availableDomains[0].domain;

        // DummyInbox generates a hard-to-guess address. It does not use
        // Mail.tm accounts, passwords, or bearer tokens.
        const result = await apiRequest("/inboxes", {
            method: "POST",
            body: { domain }
        });

        const data = result.data;
        if (!data || typeof data.address !== "string" || !data.address.includes("@")) {
            throw new Error("invalid_address_response");
        }

        const parts = data.address.split("@");
        const accountDomain = parts.slice(1).join("@");
        const account = {
            id: data.address,
            address: data.address,
            username: parts[0],
            domain: accountDomain,
            webUrl: data.webUrl || null
        };

        currentAccount = account;
        lastRenderedSignature = "";
        lastPollingErrorAt = 0;

        const emailInput = getElement("emailName");
        const domainSelect = getElement("domainSelect");
        const hiddenEmail = getElement("fullEmailHidden");

        if (emailInput) {
            emailInput.value = account.username;
            emailInput.placeholder = "";
        }

        if (domainSelect) {
            const desiredValue = `@${account.domain}`;
            const optionExists = Array.from(domainSelect.options).some(
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

        if (hiddenEmail) hiddenEmail.value = account.address;

        setInboxStatus(
            "البريد جاهز. في انتظار الرسائل الواردة...",
            "Your inbox is ready. Waiting for incoming messages...",
            true
        );

        showToast(
            getText("تم إنشاء عنوان البريد بنجاح.", "Email address created successfully."),
            "success"
        );

        if (previousAccount) {
            showToast(
                getText(
                    "العنوان السابق قد يظل قابلًا للوصول لمن يعرفه، وقد تبقى رسائله حتى 48 ساعة.",
                    "The previous address may remain accessible to anyone who knows it, and its messages may remain for up to 48 hours."
                ),
                "error"
            );
        }

        startPolling();
    } catch (error) {
        console.error("Address creation failed:", error);
        currentAccount = previousAccount;

        if (currentAccount) {
            startPolling();
        } else {
            const emailInput = getElement("emailName");
            const hiddenEmail = getElement("fullEmailHidden");

            if (emailInput) {
                emailInput.value = "";
                emailInput.placeholder = getText(
                    "تعذر إنشاء البريد",
                    "Could not create email"
                );
            }
            if (hiddenEmail) hiddenEmail.value = "";

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

function generateNewEmail() {
    if (isCreatingAccount) return;

    if (currentAccount) {
        const confirmed = window.confirm(getText(
            "إنشاء عنوان جديد؟ العنوان الحالي لا يُحذف من خدمة البريد، وقد تظل الرسائل متاحة لمن يعرف العنوان لمدة تصل إلى 48 ساعة.",
            "Create a new address? The current address is not deleted from the mail service, and messages may remain accessible to anyone who knows it for up to 48 hours."
        ));
        if (!confirmed) return;
    }

    createAccount();
}


// ======================================================
// Fetch and Render Messages
// ======================================================

async function fetchMessages(options = {}) {
    const manual = options.manual === true;

    if (!currentAccount || !currentAccount.address) {
        if (manual) {
            showToast(
                getText("أنشئ بريدًا مؤقتًا أولًا.", "Generate an email address first."),
                "error"
            );
        }
        return false;
    }

    if (isFetchingMessages) return false;
    isFetchingMessages = true;

    const requestedAddress = currentAccount.address;
    const inbox = getElement("inboxMessages");
    if (inbox) inbox.setAttribute("aria-busy", "true");

    try {
        const path = `/inboxes/${requestedAddress}/messages?limit=50`;
        const result = await apiRequest(path);

        if (!currentAccount || currentAccount.address !== requestedAddress) {
            return false;
        }

        const messages = result.data && Array.isArray(result.data.messages)
            ? result.data.messages
            : [];

        renderMessages(messages);

        if (manual) {
            showToast(getText("تم تحديث صندوق الوارد.", "Inbox refreshed."), "success");
        }

        lastPollingErrorAt = 0;
        return true;
    } catch (error) {
        console.error("Fetching messages failed:", error);

        if (!currentAccount || currentAccount.address !== requestedAddress) {
            return false;
        }

        const now = Date.now();
        if (manual || now - lastPollingErrorAt > 30000) {
            showToast(getApiErrorMessage(error), "error");
            lastPollingErrorAt = now;
        }

        return false;
    } finally {
        isFetchingMessages = false;
        if (currentAccount && currentAccount.address === requestedAddress) {
            const currentInbox = getElement("inboxMessages");
            if (currentInbox) currentInbox.setAttribute("aria-busy", "false");
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

    const signature = JSON.stringify(messages.map(message => ({
        id: message.id,
        subject: message.subject,
        snippet: message.snippet,
        from: message.from,
        fromName: message.fromName,
        receivedAt: message.receivedAt
    })));

    if (signature === lastRenderedSignature) return;
    lastRenderedSignature = signature;

    const fragment = document.createDocumentFragment();

    messages.forEach(message => {
        const item = document.createElement("div");
        item.className = "message-item";
        item.style.cssText = [
            "background:#1f1f1f", "padding:12px", "margin:8px 0",
            "border-radius:8px", "border-inline-start:4px solid #00cc88",
            "width:100%", "box-sizing:border-box", "text-align:start",
            "overflow-wrap:anywhere"
        ].join(";");

        const sender = document.createElement("strong");
        sender.textContent = message.fromName || message.from || "Unknown sender";

        const subject = document.createElement("div");
        subject.style.cssText = "color:#aaa; margin-top:5px; overflow-wrap:anywhere;";
        subject.textContent = message.subject || getText("بدون عنوان", "No subject");

        const snippet = document.createElement("p");
        snippet.style.cssText = "margin:8px 0; font-size:.95rem; color:#ddd; overflow-wrap:anywhere;";
        snippet.textContent = message.snippet || "";

        const button = document.createElement("button");
        button.type = "button";
        button.style.cssText = [
            "background:#00cc88", "color:#000", "border:none",
            "padding:8px 14px", "border-radius:4px", "cursor:pointer",
            "font-weight:bold"
        ].join(";");

        const buttonLabel = document.createElement("span");
        buttonLabel.className = "t";
        buttonLabel.dataset.ar = "عرض الرسالة";
        buttonLabel.dataset.en = "View message";
        buttonLabel.textContent = getText("عرض الرسالة", "View message");
        button.appendChild(buttonLabel);
        button.addEventListener("click", () => viewMessage(message.id));

        item.appendChild(sender);
        item.appendChild(subject);
        item.appendChild(snippet);
        item.appendChild(button);

        if (message.receivedAt) {
            const date = document.createElement("small");
            date.style.cssText = "display:block; margin-top:8px; color:#888;";
            const parsedDate = new Date(message.receivedAt);
            if (!Number.isNaN(parsedDate.getTime())) {
                date.textContent = new Intl.DateTimeFormat(
                    currentLang === "ar" ? "ar" : "en",
                    { dateStyle: "medium", timeStyle: "short" }
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

    const parsedDocument = new DOMParser().parseFromString(html, "text/html");
    parsedDocument.querySelectorAll(
        "script, style, iframe, object, embed, form, input, button"
    ).forEach(element => element.remove());

    return parsedDocument.body.textContent || "";
}

function showMessageDialog(message) {
    const existingDialog = getElement("kwikMessageDialog");
    if (existingDialog) existingDialog.remove();

    const dialog = document.createElement("dialog");
    dialog.id = "kwikMessageDialog";
    dialog.setAttribute("aria-labelledby", "kwikMessageSubject");
    dialog.style.cssText = [
        "width:min(760px,92vw)", "max-width:92vw", "max-height:85vh",
        "padding:22px", "border:1px solid #333", "border-radius:12px",
        "background:#151515", "color:#f5f5f5", "box-sizing:border-box",
        "overflow:auto"
    ].join(";");

    const heading = document.createElement("h2");
    heading.id = "kwikMessageSubject";
    heading.style.cssText = "margin:0 0 12px; overflow-wrap:anywhere;";
    heading.textContent = message.subject || getText("بدون عنوان", "No subject");

    const sender = document.createElement("p");
    sender.style.cssText = "color:#aaa; overflow-wrap:anywhere;";
    const fromLabel = message.fromName
        ? `${message.fromName} (${message.from || ""})`
        : (message.from || "Unknown sender");
    sender.textContent = `${getText("من: ", "From: ")}${fromLabel}`;

    const content = document.createElement("pre");
    content.style.cssText = [
        "white-space:pre-wrap", "overflow-wrap:anywhere", "font:inherit",
        "line-height:1.6", "max-height:55vh", "overflow:auto",
        "background:#202020", "padding:14px", "border-radius:8px",
        "color:#eee", "word-break:break-word"
    ].join(";");

    const bodyText = typeof message.text === "string" ? message.text.trim() : "";
    const htmlText = messageHtmlToText(message.html).trim();
    content.textContent = bodyText || htmlText || message.snippet ||
        getText("لا يوجد محتوى نصي متاح.", "No message text is available.");

    const closeButton = document.createElement("button");
    closeButton.type = "button";
    closeButton.textContent = getText("إغلاق", "Close");
    closeButton.style.cssText = [
        "background:#00cc88", "color:#000", "border:none",
        "border-radius:6px", "padding:10px 18px",
        "font-weight:bold", "cursor:pointer"
    ].join(";");

    closeButton.addEventListener("click", () => {
        if (dialog.open && typeof dialog.close === "function") dialog.close();
        else dialog.remove();
    });

    dialog.appendChild(heading);
    dialog.appendChild(sender);
    dialog.appendChild(content);
    dialog.appendChild(closeButton);

    dialog.addEventListener("click", event => {
        if (event.target === dialog && dialog.open) dialog.close();
    });
    dialog.addEventListener("close", () => dialog.remove(), { once: true });

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
    if (!currentAccount || !currentAccount.address || id === undefined || id === null) return;

    const requestedAddress = currentAccount.address;

    try {
        const path = `/inboxes/${requestedAddress}/messages/${encodeURIComponent(id)}`;
        const result = await apiRequest(path);

        if (!currentAccount || currentAccount.address !== requestedAddress) return;

        const data = result.data;
        const rawMessage = data && data.message;
        if (!rawMessage || rawMessage.id === undefined) {
            throw new Error("invalid_message_response");
        }

        // The service returns sender fields as strings. Normalize them for
        // the safe dialog renderer; never insert the HTML body into the page.
        showMessageDialog({
            id: rawMessage.id,
            subject: rawMessage.subject || "",
            from: rawMessage.from || "",
            fromName: rawMessage.fromName || "",
            text: rawMessage.text || "",
            html: rawMessage.html || "",
            snippet: rawMessage.snippet || ""
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

    if (!currentAccount) {
        showToast(getText("أنشئ بريدًا مؤقتًا أولًا.", "Generate an email address first."), "error");
        return;
    }

    if (icon) icon.classList.add("fa-spin");
    try {
        await fetchMessages({ manual: true });
    } finally {
        setTimeout(() => {
            if (icon) icon.classList.remove("fa-spin");
        }, 500);
    }
}


// ======================================================
// Clear the Current Address from This Page
// ======================================================

function deleteEmail() {
    // This only clears this browser page. DummyInbox's API is receive-only;
    // this action does not delete the mailbox or its messages from the service.
    stopPolling();
    currentAccount = null;
    lastRenderedSignature = "";

    const emailInput = getElement("emailName");
    const hiddenEmail = getElement("fullEmailHidden");

    if (emailInput) {
        emailInput.value = "";
        emailInput.placeholder = getText("أنشئ بريدًا جديدًا", "Generate a new email");
    }
    if (hiddenEmail) hiddenEmail.value = "";

    setInboxStatus(
        "تم مسح البريد من الصفحة. يمكنك إنشاء بريد جديد.",
        "The address was cleared from this page. You can generate a new one."
    );

    showToast(
        getText("تم مسح البريد من الصفحة فقط، ولم يُحذف من الخادم.", "The address was cleared from this page only; it was not deleted from the server."),
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
            getText("لا يوجد بريد لنسخه. أنشئ بريدًا أولًا.", "There is no email address to copy. Generate one first."),
            "error"
        );
        return;
    }

    try {
        if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
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
            if (!copied) throw new Error("clipboard_copy_failed");
        }

        showToast(getText("تم نسخ عنوان البريد.", "Email address copied."), "success");
    } catch (error) {
        console.error("Copy failed:", error);
        showToast(
            getText("تعذر النسخ تلقائيًا. حاول نسخ العنوان يدويًا.", "Automatic copying failed. Please copy the address manually."),
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
        "position:fixed", "top:20px", "left:50%", "transform:translateX(-50%)",
        "padding:14px 22px", "border-radius:8px", "color:#fff",
        "z-index:999999", "font-weight:600", "box-shadow:0 4px 15px rgba(0,0,0,.3)",
        "max-width:90vw", "box-sizing:border-box", "text-align:center", "line-height:1.5",
        `background:${type === "success" ? "#008f62" : "#b83232"}`
    ].join(";");
    toast.textContent = message;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.transition = "opacity .3s";
        toast.style.opacity = "0";
        setTimeout(() => toast.remove(), 350);
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
    if (lang !== "en" && lang !== "ar") return;

    currentLang = lang;
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === "ar" ? "rtl" : "ltr";

    const currentLanguageText = getElement("currentLangText");
    if (currentLanguageText) {
        currentLanguageText.textContent = lang === "ar" ? "العربية" : "English";
    }

    document.querySelectorAll(".t").forEach(element => {
        const translatedText = element.getAttribute(`data-${lang}`);
        if (translatedText !== null) element.textContent = translatedText;
    });
}


// ======================================================
// Email Address Display
// ======================================================

function updateFullEmail() {
    const hiddenEmail = getElement("fullEmailHidden");
    if (hiddenEmail) {
        hiddenEmail.value = currentAccount && currentAccount.address
            ? currentAccount.address
            : "";
    }
}


// ======================================================
// Provider Attribution
// ======================================================

function ensureProviderAttribution() {
    const footer = document.querySelector("footer");
    if (!footer || footer.querySelector("[data-provider-attribution]")) return;

    const paragraph = document.createElement("p");
    paragraph.dataset.providerAttribution = "true";
    paragraph.style.cssText = "margin-top:12px; font-size:.85rem; opacity:.75;";

    const label = document.createElement("span");
    label.className = "t";
    label.dataset.ar = "مزود البريد الخارجي: ";
    label.dataset.en = "Third-party inbox provider: ";
    label.textContent = getText("مزود البريد الخارجي: ", "Third-party inbox provider: ");

    const link = document.createElement("a");
    link.href = "https://dummyinbox.com/";
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "DummyInbox";

    paragraph.appendChild(label);
    paragraph.appendChild(link);

    const footerLinks = footer.lastElementChild;
    if (footerLinks) footer.insertBefore(paragraph, footerLinks);
    else footer.appendChild(paragraph);
}


// ======================================================
// Initialize Application
// ======================================================

async function initializeApp() {
    switchLanguage(document.documentElement.lang || "en");
    ensureProviderAttribution();

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
