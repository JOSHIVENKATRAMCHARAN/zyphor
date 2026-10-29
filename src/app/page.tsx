"use client";

import { useState, useRef, useEffect, useMemo } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Lock, Shield, Zap, UploadCloud, CheckCircle2, Copy, Share2, Mail, MessageCircle, Send } from "lucide-react";
import { encryptFile } from "@/lib/crypto";
import { generateMemorablePassphrase } from "@/lib/words";
import { withCsrfHeaders } from "@/lib/csrf-client";
import SiteFooter from "@/components/SiteFooter";
import { Turnstile, type TurnstileInstance } from "@marsidev/react-turnstile";

// Define the available password modes
type PasswordMode = "auto" | "random" | "memorable" | "custom" | "webrtc";
type PreviewKind = "image" | "video" | "audio" | "pdf";
const MAX_UPLOAD_FILE_BYTES = 50 * 1024 * 1024;
const TURNSTILE_FLAG = process.env.NEXT_PUBLIC_TURNSTILE_ENABLED?.toLowerCase();
const TURNSTILE_ENABLED = TURNSTILE_FLAG === "true" ? true : TURNSTILE_FLAG === "false" ? false : process.env.NODE_ENV === "production";

async function readUploadResponse(response: Response): Promise<{ success?: boolean; error?: string; linkId?: string }> {
  const responseText = await response.text();
  let payload: { success?: boolean; error?: string; linkId?: string } | null = null;

  try {
    payload = responseText ? JSON.parse(responseText) : null;
  } catch {
    // A reverse proxy can reject a request before the API route has a chance to return JSON.
  }

  if (response.ok && payload) return payload;
  if (payload?.error) throw new Error(payload.error);
  if (response.status === 413) {
    throw new Error("The upload is larger than the server's request limit. Please choose smaller files or ask the administrator to allow 512 MB requests.");
  }
  throw new Error(`Upload request failed (${response.status}). Please try again.`);
}

function getPreviewKind(file: File): PreviewKind | null {
  const mime = file.type || "";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "video";
  if (mime.startsWith("audio/")) return "audio";
  if (mime === "application/pdf") return "pdf";
  return null;
}

export default function Home() {
  const [files, setFiles] = useState<File[]>([]);
  const [uploading, setUploading] = useState(false);
  const [password, setPassword] = useState("");
  const [progress, setProgress] = useState(0);
  const [shareLink, setShareLink] = useState("");
  const [generatedPassword, setGeneratedPassword] = useState("");
  const [copiedLink, setCopiedLink] = useState(false);
  const [copiedShareMessage, setCopiedShareMessage] = useState(false);
  const [isOneTime, setIsOneTime] = useState(false);
  const [allowSave, setAllowSave] = useState(true);
  const [authRequired, setAuthRequired] = useState(false);
  const [savePasswordToDevice, setSavePasswordToDevice] = useState(true);
  const [customLinkId, setCustomLinkId] = useState("");
  const [passwordMode, setPasswordMode] = useState<PasswordMode>("auto");
  const fileInputRef = useRef<HTMLInputElement>(null);

  const [user, setUser] = useState<any>(null);
  const [isLoadingAuth, setIsLoadingAuth] = useState(true);
  const [turnstileToken, setTurnstileToken] = useState<string | null>(null);
  const turnstileRef = useRef<TurnstileInstance>(null);

  const [isWebrtcConnecting, setIsWebrtcConnecting] = useState(false);
  const [webrtcStatus, setWebrtcStatus] = useState("");
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const dataChannelRef = useRef<RTCDataChannel | null>(null);
  const router = useRouter();

  const previewableFiles = useMemo(
    () =>
      files
        .map((file) => {
          const kind = getPreviewKind(file);
          return kind ? { file, kind } : null;
        })
        .filter((value): value is { file: File; kind: PreviewKind } => Boolean(value)),
    [files]
  );
  const [previewItems, setPreviewItems] = useState<Array<{ file: File; kind: PreviewKind; url: string }>>([]);
  const hasNonPreviewableFiles = files.length > previewableFiles.length;

  useEffect(() => {
    if (previewableFiles.length === 0) {
      setPreviewItems([]);
      return;
    }

    const items = previewableFiles.map(({ file, kind }) => ({
      file,
      kind,
      url: URL.createObjectURL(file),
    }));
    setPreviewItems(items);

    return () => {
      items.forEach((item) => URL.revokeObjectURL(item.url));
    };
  }, [previewableFiles]);

  useEffect(() => {
    fetch('/api/auth/me')
      .then(res => res.json())
      .then(data => {
        if (data.user) setUser(data.user);
        setIsLoadingAuth(false);
      })
      .catch(() => setIsLoadingAuth(false));
  }, []);

  const handleFileSelect = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files) {
      const selectedFiles = Array.from(e.target.files);
      const oversizedFile = selectedFiles.find((file) => file.size > MAX_UPLOAD_FILE_BYTES);
      if (oversizedFile) {
        alert(`File exceeds the 50 MB limit: ${oversizedFile.name}`);
        e.target.value = "";
        return;
      }
      if (selectedFiles.length > 10) {
        alert("You can upload up to 10 files per transfer.");
        e.target.value = "";
        return;
      }
      setFiles(selectedFiles);
    }
  };

  const startWebrtcSession = async () => {
    if (files.length === 0) return alert("Files are required.");
    const oversizedFile = files.find((file) => file.size > MAX_UPLOAD_FILE_BYTES);
    if (oversizedFile) return alert(`File exceeds the 50 MB limit: ${oversizedFile.name}`);
    
    // 1. Generate a unique channel ID
    const channelId = Math.random().toString(36).substring(2, 15);
    const linkDetail = `${window.location.origin}/p2p/${channelId}`;
    setShareLink(linkDetail);
    setIsWebrtcConnecting(true);
    setWebrtcStatus("Initializing connection...");
    
    // 2. Setup WebRTC PeerConnection
    const pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    peerConnectionRef.current = pc;

    // 3. Create Data Channel for file transfer
    const dc = pc.createDataChannel("fileTransfer");
    dataChannelRef.current = dc;
    
    dc.onopen = () => {
      setWebrtcStatus("Connected! Sending file...");
      sendFileViaWebRTC();
    };
    
    dc.onclose = () => {
      if (progress < 100) setWebrtcStatus("Connection lost. Transfer failed.");
    };

    // 4. Handle ICE candidates (send to signaling server)
    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        await fetch("/api/webrtc/signal", {
          method: "POST",
          headers: withCsrfHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            channelId,
            sender: "host",
            type: "candidate",
            data: event.candidate
          })
        });
      }
    };

    // 5. Create Offer and set local description
    try {
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      
      // Send offer to signaling server
      await fetch("/api/webrtc/signal", {
        method: "POST",
        headers: withCsrfHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({
          channelId,
          sender: "host",
          type: "offer",
          data: offer
        })
      });
      
      setWebrtcStatus("Waiting for recipient to open the link...");
      
      // 6. Start polling for Answer and receiver's ICE candidates
      let lastPollId = 0;
      const pollInterval = setInterval(async () => {
        if (pc.signalingState === "closed") {
          clearInterval(pollInterval);
          return;
        }
        
        try {
          const res = await fetch(`/api/webrtc/signal?channelId=${channelId}&lastId=${lastPollId}`);
          if (res.ok) {
            const { signals } = await res.json();
            
            for (const signal of signals) {
              lastPollId = Math.max(lastPollId, signal.id);
              
              if (signal.sender === "client") {
                if (signal.type === "answer" && pc.signalingState === "have-local-offer") {
                  await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
                  setWebrtcStatus("Recipient found! Connecting...");
                } else if (signal.type === "candidate" && pc.remoteDescription) {
                  await pc.addIceCandidate(new RTCIceCandidate(signal.data));
                }
              }
            }
          }
        } catch (err) {
          console.error("Polling error:", err);
        }
      }, 2000);
      
    } catch (err) {
      console.error("Error creating WebRTC offer:", err);
      setWebrtcStatus("Failed to initialize WebRTC.");
    }
  };

  const sendFileViaWebRTC = () => {
    const dc = dataChannelRef.current;
    if (!dc || dc.readyState !== 'open') return;

    // Send single file for now (P2P usually handles 1 at a time smoothly, but could be extended)
    const file = files[0];
    
    // First message: metadata
    dc.send(JSON.stringify({
      type: 'metadata',
      name: file.name,
      size: file.size,
      mime: file.type
    }));

    // Start chunking and sending
    const chunkSize = 16 * 1024; // 16KB chunks
    let offset = 0;
    
    setUploading(true);
    setProgress(0);

    const checkBufferAndSend = () => {
      // Respect bufferedAmountLowThreshold
      if (dc.bufferedAmount > dc.bufferedAmountLowThreshold) {
        // Wait for buffer to drain
        return; 
      }
      
      if (offset < file.size) {
        const slice = file.slice(offset, offset + chunkSize);
        slice.arrayBuffer().then(buffer => {
          dc.send(buffer);
          offset += buffer.byteLength;
          setProgress((offset / file.size) * 100);
          
          if (offset < file.size) {
            // Use setTimeout to avoid call stack size exceeded, and yield to UI
            setTimeout(checkBufferAndSend, 0);
          } else {
            // Done sending
            dc.send(JSON.stringify({ type: 'eof' }));
            setWebrtcStatus("Transfer complete!");
            setProgress(100);
            setUploading(false);
          }
        });
      }
    };

    dc.bufferedAmountLowThreshold = 65536; // 64KB
    dc.onbufferedamountlow = () => {
      checkBufferAndSend();
    };

    // Kick off sending
    checkBufferAndSend();
  };


  const handleUpload = async () => {
    if (isLoadingAuth) {
      alert("Checking authentication. Please wait a moment and try again.");
      return;
    }

    if (!user) {
      alert("Please log in to upload files.");
      router.push("/login?next=%2F");
      return;
    }
    if (TURNSTILE_ENABLED && !turnstileToken) {
      alert("Please complete the security check before uploading.");
      return;
    }

    if (files.length === 0) return alert("Files are required.");
    
    let encryptionKey = "";
    let shouldEmbedInLink = false;
    let shouldDisplayToUser = false;

    // Handle password generation based on mode
    if (passwordMode === "auto") {
      encryptionKey = Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
      shouldEmbedInLink = true;
    } else if (passwordMode === "random") {
      // Generate a strong random password (e.g. A8!x9Qz2)
      const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+";
      for (let i = 0; i < 16; i++) {
        encryptionKey += chars.charAt(Math.floor(Math.random() * chars.length));
      }
      shouldDisplayToUser = true;
    } else if (passwordMode === "memorable") {
      encryptionKey = generateMemorablePassphrase(3);
      shouldDisplayToUser = true;
    } else if (passwordMode === "custom") {
      if (!password) return alert("Please enter your custom password.");
      encryptionKey = password;
    } else if (passwordMode === "webrtc") {
      return startWebrtcSession(); // Trigger WebRTC flow
    }
    
    setUploading(true);
    setProgress(10); // Start progress

    try {
      const formData = new FormData();
      formData.append("maxDownloads", isOneTime ? "1" : "0");
      formData.append("isProtected", "true");
      formData.append("allowSave", allowSave.toString());
      formData.append("authRequired", authRequired.toString());
      if (TURNSTILE_ENABLED && turnstileToken) formData.append("turnstileToken", turnstileToken);

      
      if (customLinkId) {
        formData.append("customLinkId", customLinkId);
      }
      
      let currentProgress = 10;
      
      for (const file of files) {
        // Encrypt file locally
        const { encryptedData, salt, iv } = await encryptFile(file, encryptionKey);
        
        formData.append("files", encryptedData, `${file.name}.enc`);
        formData.append("salt", window.btoa(String.fromCharCode(...Array.from(salt))));
        formData.append("iv", window.btoa(String.fromCharCode(...Array.from(iv))));
        formData.append("originalName", file.name);
        formData.append("originalMime", file.type || "application/octet-stream");
        
        currentProgress += (80 / files.length);
        setProgress(currentProgress);
      }

      // Upload to server
      const res = await fetch("/api/upload", {
        method: "POST",
        headers: withCsrfHeaders(),
        body: formData,
      });

      const data = await readUploadResponse(res);
      if (data.success && data.linkId) {
        const linkDetail = `${window.location.origin}/${data.linkId}`;
        setShareLink(shouldEmbedInLink ? `${linkDetail}#${encryptionKey}` : linkDetail);
        
        // Save locally for dashboard convenience with an expiry to reduce long-lived key exposure.
        if (savePasswordToDevice && typeof window !== "undefined") {
          const oneWeekMs = 7 * 24 * 60 * 60 * 1000;
          localStorage.setItem(
            `vaultshare_key_${data.linkId}`,
            JSON.stringify({
              key: encryptionKey,
              expiresAt: Date.now() + oneWeekMs,
            })
          );
        }

        if (shouldDisplayToUser) {
          setGeneratedPassword(encryptionKey);
        }
        setProgress(100);
      } else {
        throw new Error(data.error || "Upload failed. Please try again.");
      }
    } catch (err) {
      console.error(err);
      alert("Upload failed. " + err);
    } finally {
      setUploading(false);
      setTurnstileToken(null);
      turnstileRef.current?.reset();
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(shareLink);
    setCopiedLink(true);
    window.setTimeout(() => setCopiedLink(false), 1800);
  };

  const copyShareMessage = () => {
    navigator.clipboard.writeText(shareText);
    setCopiedShareMessage(true);
    window.setTimeout(() => setCopiedShareMessage(false), 1800);
  };

  const shareNatively = async () => {
    if (!shareLink) return;
    if (typeof navigator === "undefined" || typeof navigator.share !== "function") {
      alert("Native sharing is not supported in this browser.");
      return;
    }

    try {
      await navigator.share({
        title: "Secure file link",
        text: "Secure file shared via Zyphor. Use Zyphor for secure and easy sharing.",
        url: shareLink,
      });
    } catch {
      // User cancelled or platform blocked share
    }
  };

  const appOrigin = typeof window !== "undefined" ? window.location.origin : "";
  const promoLine = "Use Zyphor for secure and easy sharing.";
  const encodedLink = encodeURIComponent(shareLink);
  const shareText = `Secure file link: ${shareLink}\n\n${promoLine}\n${appOrigin}`;
  const encodedText = encodeURIComponent(shareText);
  const emailSubject = encodeURIComponent("Secure file shared via Zyphor");
  const emailBody = encodeURIComponent(`Hi,\n\nHere is the secure file link:\n${shareLink}\n\n${promoLine}\n${appOrigin}\n\nIf needed, I will share the password separately.`);
  const socialTargets = [
    { label: "WhatsApp", href: `https://wa.me/?text=${encodedText}`, icon: MessageCircle },
    { label: "Telegram", href: `https://t.me/share/url?url=${encodedLink}&text=${encodeURIComponent(`Secure file link. ${promoLine}`)}`, icon: Send },
    { label: "X", href: `https://twitter.com/intent/tweet?text=${encodedText}`, icon: Share2 },
    { label: "Facebook", href: `https://www.facebook.com/sharer/sharer.php?u=${encodedLink}`, icon: Share2 },
  ];

  // Helper to reset state
  const resetShare = () => {
    setShareLink(""); 
    setGeneratedPassword(""); 
    setCopiedLink(false);
    setCopiedShareMessage(false);
    setFiles([]); 
    setPassword(""); 
    setIsOneTime(false); 
    setCustomLinkId(""); 
    setProgress(0);
    setIsWebrtcConnecting(false);
    setWebrtcStatus("");
    
    // Cleanup WebRTC
    if (dataChannelRef.current) {
      dataChannelRef.current.close();
      dataChannelRef.current = null;
    }
    if (peerConnectionRef.current) {
      peerConnectionRef.current.close();
      peerConnectionRef.current = null;
    }
  };

  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header className="main-header">
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <img src="/logo.png" alt="Zyphor Logo" style={{ height: "32px", width: "auto" }} />
          <h1 style={{ fontSize: "1.25rem", fontWeight: "700", letterSpacing: "-0.5px" }}>Zyphor</h1>
        </div>
        <nav style={{ display: "flex", gap: "1rem" }}>
          {!isLoadingAuth && user ? (
            <Link href="/dashboard" className="btn btn-primary">Go to Vault</Link>
          ) : !isLoadingAuth ? (
            <>
              <Link href="/login" className="btn btn-secondary">Log In</Link>
              <Link href="/register" className="btn btn-primary">Sign Up</Link>
            </>
          ) : null}
        </nav>
      </header>

      <section className="main-section">
        <h2 className="title-gradient" style={{ fontSize: "clamp(2.5rem, 5vw, 4rem)", fontWeight: "800", marginBottom: "1rem", lineHeight: "1.2", maxWidth: "800px" }}>
          Share securely with true End-to-End Encryption
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "clamp(1rem, 2vw, 1.25rem)", maxWidth: "600px", marginBottom: "3rem" }}>
          Military-grade AES-256 encryption within your browser. 
        </p>

        <div className="glass-panel" style={{ maxWidth: "600px" }}>
          
          {shareLink ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", alignItems: "center" }}>
              <CheckCircle2 color="#10b981" size={64} style={{ marginBottom: "1rem" }} />
              
              {isWebrtcConnecting ? (
                <>
                  <h3 style={{ fontSize: "1.5rem", fontWeight: "600" }}>Live P2P Transfer</h3>
                  <p style={{ color: "var(--text-secondary)" }}>{webrtcStatus}</p>
                </>
              ) : (
                <>
                  <h3 style={{ fontSize: "1.5rem", fontWeight: "600" }}>Files Uploaded & Encrypted!</h3>
                  <p style={{ color: "var(--text-secondary)" }}>Share this link with your recipient. Don't forget to send them the password through a secure channel.</p>
                </>
              )}
              
              <div style={{ width: "100%", display: "flex", gap: "0.5rem" }}>
                <input readOnly value={shareLink} className="input-field" style={{ flex: 1, color: "var(--accent-blue)" }} />
                <button onClick={copyToClipboard} className="btn btn-primary"><Copy size={18} /></button>
              </div>
              <p style={{ margin: 0, fontSize: "0.8rem", color: copiedLink ? "#10b981" : "var(--text-secondary)" }}>
                {copiedLink ? "Link copied. Ready to share." : "Copy the link or share directly using an app below."}
              </p>
              <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                Share message includes: "Use Zyphor for secure and easy sharing."
              </p>
              <button onClick={copyShareMessage} className="btn btn-secondary" style={{ width: "100%", border: "1px solid var(--glass-border)" }}>
                {copiedShareMessage ? "Share message copied" : "Copy Share Message"}
              </button>

              <div style={{ width: "100%", display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(120px, 1fr))", gap: "0.6rem" }}>
                <button onClick={shareNatively} className="btn btn-secondary" style={{ border: "1px solid var(--glass-border)" }}>
                  <Share2 size={16} /> Share
                </button>
                <a href={`mailto:?subject=${emailSubject}&body=${emailBody}`} className="btn btn-secondary" style={{ border: "1px solid var(--glass-border)", textDecoration: "none" }}>
                  <Mail size={16} /> Email
                </a>
                {socialTargets.map((target) => {
                  const Icon = target.icon;
                  return (
                    <a
                      key={target.label}
                      href={target.href}
                      target="_blank"
                      rel="noreferrer"
                      className="btn btn-secondary"
                      style={{ border: "1px solid var(--glass-border)", textDecoration: "none" }}
                    >
                      <Icon size={16} /> {target.label}
                    </a>
                  );
                })}
              </div>

              {previewItems.length > 0 && !isWebrtcConnecting && (
                <div style={{ width: "100%", textAlign: "left", background: "rgba(0,0,0,0.2)", border: "1px solid var(--glass-border)", padding: "1rem", borderRadius: "var(--radius-sm)" }}>
                  <p style={{ fontSize: "0.9rem", color: "var(--text-secondary)", marginBottom: "0.6rem" }}>
                    File Preview
                  </p>
                  <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
                    {previewItems.map((item) => (
                      <div key={`${item.file.name}-${item.file.size}-${item.file.lastModified}`} style={{ display: "flex", flexDirection: "column", gap: "0.5rem" }}>
                        <p style={{ margin: 0, fontSize: "0.85rem", color: "var(--text-secondary)" }}>{item.file.name}</p>
                        {item.kind === "image" && (
                          <img src={item.url} alt={item.file.name} style={{ width: "100%", maxHeight: "280px", objectFit: "contain", borderRadius: "8px" }} />
                        )}
                        {item.kind === "video" && (
                          <video src={item.url} controls style={{ width: "100%", maxHeight: "280px", borderRadius: "8px" }} />
                        )}
                        {item.kind === "audio" && (
                          <audio src={item.url} controls style={{ width: "100%" }} />
                        )}
                        {item.kind === "pdf" && (
                          <iframe title={`PDF Preview ${item.file.name}`} src={item.url} style={{ width: "100%", height: "280px", border: "none", borderRadius: "8px" }} />
                        )}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {previewItems.length === 0 && files.length > 0 && !isWebrtcConnecting && (
                <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                  Preview is not available for this file type.
                </p>
              )}
              {previewItems.length > 0 && hasNonPreviewableFiles && !isWebrtcConnecting && (
                <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>
                  Some selected files do not support preview.
                </p>
              )}

              {generatedPassword && (
                <div style={{ width: "100%", textAlign: "left", background: "rgba(59, 130, 246, 0.1)", border: "1px solid var(--accent-blue)", padding: "1rem", borderRadius: "var(--radius-sm)" }}>
                  <p style={{ fontSize: "0.9rem", color: "var(--accent-blue)", fontWeight: "600", marginBottom: "0.5rem" }}>Your Encryption Password:</p>
                  <div style={{ display: "flex", gap: "0.5rem" }}>
                    <code style={{ flex: 1, padding: "0.5rem", background: "rgba(0,0,0,0.3)", borderRadius: "4px", fontSize: "1rem", userSelect: "all", fontFamily: "monospace" }}>
                      {generatedPassword}
                    </code>
                    <button onClick={() => { navigator.clipboard.writeText(generatedPassword); alert("Password copied!"); }} className="btn btn-primary" style={{ padding: "0.5rem" }}>
                      Copy
                    </button>
                  </div>
                  <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "0.5rem" }}>
                    Share this password separately. We do not store it and cannot recover it if lost.
                  </p>
                </div>
              )}
              
              {uploading && isWebrtcConnecting && (
                <div style={{ width: "100%", textAlign: "left" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                    <span style={{ fontSize: "0.8rem", color: "var(--text-secondary)" }}>Transferring...</span>
                    <span style={{ fontSize: "0.8rem", color: "var(--accent-blue)" }}>{Math.round(progress)}%</span>
                  </div>
                  <div style={{ width: "100%", height: "4px", background: "var(--glass-border)", borderRadius: "2px", overflow: "hidden" }}>
                    <div style={{ width: `${progress}%`, height: "100%", background: "var(--accent-blue)", transition: "width 0.1s linear" }}></div>
                  </div>
                </div>
              )}

              <button onClick={resetShare} className="btn btn-secondary" style={{ width: "100%" }}>
                Share Another File
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem" }}>
              <input type="file" multiple ref={fileInputRef} onChange={handleFileSelect} style={{ display: "none" }} />
              
              <div 
                onClick={() => fileInputRef.current?.click()}
                className="upload-zone"
                style={{ border: `2px dashed ${files.length > 0 ? 'var(--accent-blue)' : 'var(--glass-border)'}`, padding: "3rem", borderRadius: "var(--radius-md)", cursor: "pointer" }}
              >
                <Zap style={{ margin: "0 auto", color: files.length > 0 ? "var(--accent-blue)" : "var(--accent-purple)", marginBottom: "1rem" }} size={48} />
                <h3 style={{ fontSize: "1.25rem", fontWeight: "600", marginBottom: "0.5rem" }}>
                  {files.length > 0 ? `${files.length} file(s) selected` : "Click to select files"}
                </h3>
                <p style={{ color: "var(--text-secondary)" }}>
                  {files.length > 0 
                    ? files.map(f => f.name).join(", ").substring(0, 50) + "..."
                    : "Max 1GB per transfer for free users"}
                </p>
              </div>

              {/* Guest Warning */}
              {!isLoadingAuth && !user && files.length > 0 && (
                <div style={{ background: "rgba(59, 130, 246, 0.1)", border: "1px solid var(--accent-blue)", padding: "1rem", borderRadius: "var(--radius-sm)", textAlign: "left" }}>
                  <p style={{ margin: 0, fontSize: "0.9rem", color: "var(--text-primary)" }}>
                    <span style={{ fontWeight: "600", color: "var(--accent-blue)" }}>Login Required:</span> Uploads are available only for authenticated users. <Link href="/login" style={{ color: "var(--accent-blue)", textDecoration: "underline" }}>Log in</Link> or <Link href="/register" style={{ color: "var(--accent-blue)", textDecoration: "underline" }}>Sign up</Link> to continue.
                  </p>
                </div>
              )}
              
              {isLoadingAuth && (
                <div style={{ background: "rgba(59, 130, 246, 0.1)", border: "1px solid var(--accent-blue)", padding: "0.75rem", borderRadius: "var(--radius-sm)", textAlign: "center", color: "var(--text-secondary)", fontSize: "0.85rem" }}>
                  Loading, please wait...
                </div>
              )}

              {TURNSTILE_ENABLED && user && (
                <div style={{ display: "flex", justifyContent: "center", minHeight: "65px" }}>
                  <Turnstile
                    ref={turnstileRef}
                    siteKey={process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY || "0x4AAAAAAFrUwteEs64_zkZa"}
                    onSuccess={setTurnstileToken}
                    onExpire={() => setTurnstileToken(null)}
                    onError={() => setTurnstileToken(null)}
                  />
                </div>
              )}

              {/* Password Mode Selector */}
              <div style={{ textAlign: "left" }}>
                <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.9rem", color: "var(--text-secondary)" }}>Encryption Strategy</label>
                <div style={{ display: "flex", flexDirection: "column", gap: "0.5rem", background: "rgba(0,0,0,0.2)", padding: "0.5rem", borderRadius: "var(--radius-md)" }}>
                  
                  <label className="strategy-option" style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem", background: passwordMode === "auto" ? "rgba(59, 130, 246, 0.15)" : "transparent", border: `1px solid ${passwordMode === "auto" ? "var(--accent-blue)" : "transparent"}`, borderRadius: "var(--radius-sm)", cursor: "pointer" }}>
                    <input type="radio" name="passMode" checked={passwordMode === "auto"} onChange={() => setPasswordMode("auto")} style={{ accentColor: "var(--accent-blue)" }} />
                    <div style={{ flex: 1 }}>
                      <p style={{ margin: 0, fontWeight: "600", fontSize: "0.95rem", color: passwordMode === "auto" ? "var(--accent-blue)" : "inherit" }}>Auto-Link (Easiest)</p>
                      <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>Generates a key and perfectly embeds it in the link.</p>
                    </div>
                  </label>

                  <label className="strategy-option" style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem", background: passwordMode === "memorable" ? "rgba(59, 130, 246, 0.15)" : "transparent", border: `1px solid ${passwordMode === "memorable" ? "var(--accent-blue)" : "transparent"}`, borderRadius: "var(--radius-sm)", cursor: "pointer" }}>
                    <input type="radio" name="passMode" checked={passwordMode === "memorable"} onChange={() => setPasswordMode("memorable")} style={{ accentColor: "var(--accent-blue)" }} />
                    <div style={{ flex: 1 }}>
                      <p style={{ margin: 0, fontWeight: "600", fontSize: "0.95rem", color: passwordMode === "memorable" ? "var(--accent-blue)" : "inherit" }}>Memorable Passphrase</p>
                      <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>E.g. "correct-horse-battery". Easy to share via text.</p>
                    </div>
                  </label>

                  <label className="strategy-option" style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem", background: passwordMode === "random" ? "rgba(59, 130, 246, 0.15)" : "transparent", border: `1px solid ${passwordMode === "random" ? "var(--accent-blue)" : "transparent"}`, borderRadius: "var(--radius-sm)", cursor: "pointer" }}>
                    <input type="radio" name="passMode" checked={passwordMode === "random"} onChange={() => setPasswordMode("random")} style={{ accentColor: "var(--accent-blue)" }} />
                    <div style={{ flex: 1 }}>
                      <p style={{ margin: 0, fontWeight: "600", fontSize: "0.95rem", color: passwordMode === "random" ? "var(--accent-blue)" : "inherit" }}>Random Complex Key</p>
                      <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>Generates a 16-character secure string.</p>
                    </div>
                  </label>

                  <label className="strategy-option" style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem", background: passwordMode === "custom" ? "rgba(59, 130, 246, 0.15)" : "transparent", border: `1px solid ${passwordMode === "custom" ? "var(--accent-blue)" : "transparent"}`, borderRadius: "var(--radius-sm)", cursor: "pointer" }}>
                    <input type="radio" name="passMode" checked={passwordMode === "custom"} onChange={() => setPasswordMode("custom")} style={{ accentColor: "var(--accent-blue)" }} />
                    <div style={{ flex: 1 }}>
                      <p style={{ margin: 0, fontWeight: "600", fontSize: "0.95rem", color: passwordMode === "custom" ? "var(--accent-blue)" : "inherit" }}>Custom Password</p>
                      <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>Type your own secure password.</p>
                    </div>
                  </label>

                  <label className="strategy-option" style={{ display: "flex", alignItems: "center", gap: "0.75rem", padding: "0.75rem", background: passwordMode === "webrtc" ? "rgba(59, 130, 246, 0.15)" : "transparent", border: `1px solid ${passwordMode === "webrtc" ? "var(--accent-blue)" : "transparent"}`, borderRadius: "var(--radius-sm)", cursor: "pointer" }}>
                    <input type="radio" name="passMode" checked={passwordMode === "webrtc"} onChange={() => setPasswordMode("webrtc")} style={{ accentColor: "var(--accent-blue)" }} />
                    <div style={{ flex: 1 }}>
                      <p style={{ margin: 0, fontWeight: "600", fontSize: "0.95rem", color: passwordMode === "webrtc" ? "var(--accent-blue)" : "inherit" }}>Live P2P Transfer (WebRTC)</p>
                      <p style={{ margin: 0, fontSize: "0.8rem", color: "var(--text-secondary)" }}>Direct browser-to-browser transfer.</p>
                    </div>
                  </label>

                </div>
              </div>

              {passwordMode === "custom" && (
                <div style={{ textAlign: "left" }}>
                  <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.9rem", color: "var(--text-secondary)" }}>Your Custom Password</label>
                  <div style={{ position: "relative" }}>
                    <Lock style={{ position: "absolute", left: "1rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-secondary)" }} size={18} />
                    <input 
                      type="password" 
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      placeholder="Type a strong password" 
                      className="input-field" 
                      style={{ paddingLeft: "3rem" }} 
                    />
                  </div>
                </div>
              )}
              
              <div 
                onClick={() => setSavePasswordToDevice(!savePasswordToDevice)}
                style={{ 
                  display: "flex", 
                  alignItems: "center", 
                  justifyContent: "space-between",
                  padding: "1rem", 
                  background: savePasswordToDevice ? "rgba(59, 130, 246, 0.1)" : "rgba(0, 0, 0, 0.2)", 
                  border: `1px solid ${savePasswordToDevice ? "var(--accent-blue)" : "var(--glass-border)"}`,
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  textAlign: "left"
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <Shield size={16} color={savePasswordToDevice ? "var(--accent-blue)" : "var(--text-secondary)"} />
                    <span style={{ fontWeight: "600", color: savePasswordToDevice ? "var(--accent-blue)" : "inherit" }}>Save Password on This Device</span>
                  </div>
                  <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "0.25rem", marginBottom: 0 }}>
                    Stores the encryption password locally for this browser so your dashboard can show it later.
                  </p>
                </div>
                
                <div style={{ 
                  width: "44px", 
                  height: "24px", 
                  background: savePasswordToDevice ? "var(--accent-blue)" : "rgba(255, 255, 255, 0.1)", 
                  borderRadius: "12px", 
                  position: "relative",
                  transition: "background 0.3s ease",
                  flexShrink: 0
                }}>
                  <div style={{
                    width: "18px",
                    height: "18px",
                    background: "white",
                    borderRadius: "50%",
                    position: "absolute",
                    top: "3px",
                    left: savePasswordToDevice ? "23px" : "3px",
                    transition: "left 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
                    boxShadow: "0 2px 4px rgba(0,0,0,0.2)"
                  }} />
                </div>
              </div>

              <div style={{ textAlign: "left" }}>
                <label style={{ display: "block", marginBottom: "0.5rem", fontSize: "0.9rem", color: "var(--text-secondary)" }}>Custom Link Alias (Optional)</label>
                <div style={{ position: "relative" }}>
                  <span style={{ position: "absolute", left: "1rem", top: "50%", transform: "translateY(-50%)", color: "var(--text-secondary)", fontSize: "0.9rem" }}>/</span>
                  <input 
                    type="text" 
                    value={customLinkId}
                    onChange={(e) => setCustomLinkId(e.target.value)}
                    placeholder="my-secret-file" 
                    className="input-field" 
                    style={{ paddingLeft: "2rem" }} 
                  />
                </div>
              </div>

              <div 
                onClick={() => setIsOneTime(!isOneTime)}
                style={{ 
                  display: "flex", 
                  alignItems: "center", 
                  justifyContent: "space-between",
                  padding: "1rem", 
                  background: isOneTime ? "rgba(59, 130, 246, 0.1)" : "rgba(0, 0, 0, 0.2)", 
                  border: `1px solid ${isOneTime ? "var(--accent-blue)" : "var(--glass-border)"}`,
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  textAlign: "left"
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <Zap size={16} color={isOneTime ? "var(--accent-blue)" : "var(--text-secondary)"} />
                    <span style={{ fontWeight: "600", color: isOneTime ? "var(--accent-blue)" : "inherit" }}>Burn After Reading</span>
                  </div>
                  <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "0.25rem", marginBottom: 0 }}>
                    File is automatically shredded after the first successful download.
                  </p>
                </div>
                
                {/* Custom Toggle UI */}
                <div style={{ 
                  width: "44px", 
                  height: "24px", 
                  background: isOneTime ? "var(--accent-blue)" : "rgba(255, 255, 255, 0.1)", 
                  borderRadius: "12px", 
                  position: "relative",
                  transition: "background 0.3s ease",
                  flexShrink: 0
                }}>
                  <div style={{
                    width: "18px",
                    height: "18px",
                    background: "white",
                    borderRadius: "50%",
                    position: "absolute",
                    top: "3px",
                    left: isOneTime ? "23px" : "3px",
                    transition: "left 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
                    boxShadow: "0 2px 4px rgba(0,0,0,0.2)"
                  }} />
                </div>
              </div>

              <div 
                onClick={() => setAllowSave(!allowSave)}
                style={{ 
                  display: "flex", 
                  alignItems: "center", 
                  justifyContent: "space-between",
                  padding: "1rem", 
                  background: allowSave ? "rgba(59, 130, 246, 0.1)" : "rgba(0, 0, 0, 0.2)", 
                  border: `1px solid ${allowSave ? "var(--accent-blue)" : "var(--glass-border)"}`,
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  textAlign: "left"
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <UploadCloud size={16} color={allowSave ? "var(--accent-blue)" : "var(--text-secondary)"} />
                    <span style={{ fontWeight: "600", color: allowSave ? "var(--accent-blue)" : "inherit" }}>Allow 'Save to Vault'</span>
                  </div>
                  <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "0.25rem", marginBottom: 0 }}>
                    Let recipients save a copy of this transfer to their dashboard.
                  </p>
                </div>
                
                {/* Custom Toggle UI */}
                <div style={{ 
                  width: "44px", 
                  height: "24px", 
                  background: allowSave ? "var(--accent-blue)" : "rgba(255, 255, 255, 0.1)", 
                  borderRadius: "12px", 
                  position: "relative",
                  transition: "background 0.3s ease",
                  flexShrink: 0
                }}>
                  <div style={{
                    width: "18px",
                    height: "18px",
                    background: "white",
                    borderRadius: "50%",
                    position: "absolute",
                    top: "3px",
                    left: allowSave ? "23px" : "3px",
                    transition: "left 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
                    boxShadow: "0 2px 4px rgba(0,0,0,0.2)"
                  }} />
                </div>
              </div>

              <div 
                onClick={() => setAuthRequired(!authRequired)}
                style={{ 
                  display: "flex", 
                  alignItems: "center", 
                  justifyContent: "space-between",
                  padding: "1rem", 
                  background: authRequired ? "rgba(59, 130, 246, 0.1)" : "rgba(0, 0, 0, 0.2)", 
                  border: `1px solid ${authRequired ? "var(--accent-blue)" : "var(--glass-border)"}`,
                  borderRadius: "var(--radius-sm)",
                  cursor: "pointer",
                  transition: "all 0.2s ease",
                  textAlign: "left"
                }}
              >
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
                    <Lock size={16} color={authRequired ? "var(--accent-blue)" : "var(--text-secondary)"} />
                    <span style={{ fontWeight: "600", color: authRequired ? "var(--accent-blue)" : "inherit" }}>Signed-In Users Only Can Download</span>
                  </div>
                  <p style={{ fontSize: "0.8rem", color: "var(--text-secondary)", marginTop: "0.25rem", marginBottom: 0 }}>
                    Require recipients to log in before viewing file metadata or downloading files.
                  </p>
                </div>
                
                <div style={{ 
                  width: "44px", 
                  height: "24px", 
                  background: authRequired ? "var(--accent-blue)" : "rgba(255, 255, 255, 0.1)", 
                  borderRadius: "12px", 
                  position: "relative",
                  transition: "background 0.3s ease",
                  flexShrink: 0
                }}>
                  <div style={{
                    width: "18px",
                    height: "18px",
                    background: "white",
                    borderRadius: "50%",
                    position: "absolute",
                    top: "3px",
                    left: authRequired ? "23px" : "3px",
                    transition: "left 0.3s cubic-bezier(0.175, 0.885, 0.32, 1.275)",
                    boxShadow: "0 2px 4px rgba(0,0,0,0.2)"
                  }} />
                </div>
              </div>

              {uploading && (
                <div style={{ width: "100%", height: "4px", background: "var(--glass-border)", borderRadius: "2px", overflow: "hidden" }}>
                  <div style={{ width: `${progress}%`, height: "100%", background: "var(--accent-blue)", transition: "width 0.3s ease" }}></div>
                </div>
              )}

              <button 
                onClick={handleUpload} 
                className="btn btn-primary" 
                disabled={uploading || files.length === 0 || isLoadingAuth || !user}
                style={{ width: "100%", padding: "1rem", fontSize: "1.1rem", opacity: (uploading || files.length === 0 || isLoadingAuth || !user) ? 0.5 : 1 }}
              >
                {isLoadingAuth ? "Loading, please wait..." : !user ? "Log in to Upload" : uploading ? `Encrypting & Uploading ${Math.round(progress)}%` : "Encrypt & Upload"}
              </button>
            </div>
          )}
        </div>
      </section>
      <SiteFooter />
    </main>
  );
}
