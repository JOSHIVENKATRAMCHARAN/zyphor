"use client";

import { useEffect, useState, useRef } from "react";
import { Shield, Zap, Download, Loader2 } from "lucide-react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { withCsrfHeaders } from "@/lib/csrf-client";

export default function P2PReceiver() {
  const params = useParams();
  const channelId = params.id as string;
  
  const [status, setStatus] = useState("Initializing connection...");
  const [fileMeta, setFileMeta] = useState<{name: string, size: number, mime: string} | null>(null);
  const [progress, setProgress] = useState(0);
  const [downloadUrl, setDownloadUrl] = useState("");
  const [error, setError] = useState("");
  
  const peerConnectionRef = useRef<RTCPeerConnection | null>(null);
  const receiveBufferRef = useRef<ArrayBuffer[]>([]);
  const receivedSizeRef = useRef(0);

  useEffect(() => {
    if (!channelId) return;

    let pc = new RTCPeerConnection({
      iceServers: [{ urls: "stun:stun.l.google.com:19302" }]
    });
    peerConnectionRef.current = pc;

    // Handle incoming data channel
    pc.ondatachannel = (event) => {
      const receiveChannel = event.channel;
      receiveChannel.binaryType = "arraybuffer";
      
      setStatus("Connected! Waiting for file metadata...");

      receiveChannel.onmessage = (e) => {
        if (typeof e.data === 'string') {
          const msg = JSON.parse(e.data);
          if (msg.type === 'metadata') {
            setFileMeta({ name: msg.name, size: msg.size, mime: msg.mime });
            setStatus("Receiving file...");
            receiveBufferRef.current = [];
            receivedSizeRef.current = 0;
            setProgress(0);
          } else if (msg.type === 'eof') {
            setStatus("Transfer complete! Preparing download...");
            
            // Reconstruct file
            const blob = new Blob(receiveBufferRef.current, { type: fileMeta?.mime || "application/octet-stream" });
            const url = URL.createObjectURL(blob);
            setDownloadUrl(url);
            setStatus("Ready to download");
          }
        } else {
          // It's binary file data
          receiveBufferRef.current.push(e.data);
          receivedSizeRef.current += e.data.byteLength;
          
          if (fileMeta) {
            setProgress((receivedSizeRef.current / fileMeta.size) * 100);
          }
        }
      };

      receiveChannel.onclose = () => {
        if (!downloadUrl) {
           setStatus("Connection lost.");
           setError("The sender disconnected before the transfer finished.");
        }
      };
    };

    // Handle ICE candidates
    pc.onicecandidate = async (event) => {
      if (event.candidate) {
        await fetch("/api/webrtc/signal", {
          method: "POST",
          headers: withCsrfHeaders({ "Content-Type": "application/json" }),
          body: JSON.stringify({
            channelId,
            sender: "client",
            type: "candidate",
            data: event.candidate
          })
        });
      }
    };

    let lastPollId = 0;
    
    // Start polling for Host's Offer
    const connectToHost = async () => {
      try {
        const res = await fetch(`/api/webrtc/signal?channelId=${channelId}&lastId=${lastPollId}`);
        if (res.ok) {
          const { signals } = await res.json();
          let hasOffer = false;

          for (const signal of signals) {
            lastPollId = Math.max(lastPollId, signal.id);
            
            if (signal.sender === "host") {
              if (signal.type === "offer" && pc.signalingState === "stable") {
                hasOffer = true;
                await pc.setRemoteDescription(new RTCSessionDescription(signal.data));
                
                // Create Answer
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                
                // Send Answer
                await fetch("/api/webrtc/signal", {
                  method: "POST",
                  headers: withCsrfHeaders({ "Content-Type": "application/json" }),
                  body: JSON.stringify({
                    channelId,
                    sender: "client",
                    type: "answer",
                    data: answer
                  })
                });
                
                setStatus("Answer sent, waiting for connection...");
              } else if (signal.type === "candidate" && pc.remoteDescription) {
                await pc.addIceCandidate(new RTCIceCandidate(signal.data));
              }
            }
          }
        }
      } catch (err) {
        console.error("Polling error:", err);
      }
    };

    const pollInterval = setInterval(() => {
       if (pc.signalingState === "closed" || pc.connectionState === "connected" || pc.iceConnectionState === "connected" || downloadUrl || error) {
         clearInterval(pollInterval);
         return;
       }
       connectToHost();
    }, 2000);
    
    // Initial call
    connectToHost();

    return () => {
      clearInterval(pollInterval);
      if (peerConnectionRef.current) {
         peerConnectionRef.current.close();
      }
      if (downloadUrl) {
         URL.revokeObjectURL(downloadUrl);
      }
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channelId]);


  return (
    <main style={{ minHeight: "100vh", display: "flex", flexDirection: "column" }}>
      <header style={{ padding: "1.5rem 2rem", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "0.5rem" }}>
          <img src="/logo.png" alt="Zyphor Logo" style={{ height: "32px", width: "auto" }} />
          <h1 style={{ fontSize: "1.25rem", fontWeight: "700", letterSpacing: "-0.5px" }}>Zyphor</h1>
        </div>
        <nav style={{ display: "flex", gap: "1rem" }}>
          <Link href="/" className="btn btn-secondary">Go to Home</Link>
        </nav>
      </header>

      <section style={{ flex: 1, display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "2rem", textAlign: "center" }}>
        <h2 className="title-gradient" style={{ fontSize: "3rem", fontWeight: "800", marginBottom: "1rem", lineHeight: "1.1", maxWidth: "800px" }}>
          Live P2P Transfer
        </h2>
        <p style={{ color: "var(--text-secondary)", fontSize: "1.2rem", maxWidth: "600px", marginBottom: "3rem" }}>
          Direct peer-to-peer connection. The sender must keep their tab open.
        </p>

        <div className="glass-panel" style={{ width: "100%", maxWidth: "500px", padding: "2.5rem", borderRadius: "var(--radius-lg)" }}>
          {error ? (
             <div style={{ color: "#ef4444" }}>
               <h3 style={{ fontSize: "1.25rem", fontWeight: "600", marginBottom: "0.5rem" }}>Transfer Failed</h3>
               <p>{error}</p>
             </div>
          ) : downloadUrl ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", alignItems: "center" }}>
              <Zap style={{ color: "#10b981" }} size={48} />
              <h3 style={{ fontSize: "1.5rem", fontWeight: "600" }}>Transfer Complete!</h3>
              
              {fileMeta && (
                <div style={{ background: "rgba(0,0,0,0.2)", padding: "1rem", borderRadius: "8px", width: "100%", textAlign: "left" }}>
                  <p style={{ fontWeight: "600", marginBottom: "0.25rem" }}>{fileMeta.name}</p>
                  <p style={{ color: "var(--text-secondary)", fontSize: "0.9rem", margin: 0 }}>
                    {(fileMeta.size / 1024 / 1024).toFixed(2)} MB
                  </p>
                </div>
              )}

              <a 
                href={downloadUrl} 
                download={fileMeta?.name || "downloaded-file"}
                className="btn btn-primary"
                style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "center", gap: "0.5rem" }}
              >
                <Download size={18} /> Download File
              </a>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "1.5rem", alignItems: "center" }}>
              <Loader2 className="animate-spin" style={{ color: "var(--accent-blue)" }} size={48} />
              <h3 style={{ fontSize: "1.25rem", fontWeight: "600" }}>{status}</h3>
              
              {fileMeta && (
                <div style={{ width: "100%", textAlign: "left", marginTop: "1rem" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", marginBottom: "0.5rem" }}>
                    <span style={{ fontSize: "0.9rem", fontWeight: "600" }}>{fileMeta.name}</span>
                    <span style={{ fontSize: "0.9rem", color: "var(--accent-blue)" }}>{Math.round(progress)}%</span>
                  </div>
                  <div style={{ width: "100%", height: "8px", background: "var(--glass-border)", borderRadius: "4px", overflow: "hidden" }}>
                    <div style={{ width: `${progress}%`, height: "100%", background: "var(--accent-gradient)", transition: "width 0.1s linear" }}></div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
