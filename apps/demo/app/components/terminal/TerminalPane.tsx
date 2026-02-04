"use client";

import { forwardRef, useEffect, useRef, useCallback } from "react";
import { useAtom, useAtomValue } from "jotai";
import {
  shiftHeldAtom,
  isLiveModeAtom,
  isCameraEnabledAtom,
  liveKitRoomAtom,
  voiceConnectionStatusAtom,
  voiceAgentConnectedAtom,
} from "@/src/atoms";
import { TerminalMessage } from "./TerminalMessage";
import { TerminalInput } from "./TerminalInput";
import { ScanlinesToggle } from "./Scanlines";
import { ThinkingSpinner } from "./ThinkingSpinner";
import type { Id } from "@/convex/_generated/dataModel";
import type { DisplayInstance } from "@/src/types/display";
import { RoomEvent, Track } from "livekit-client";

interface Message {
  _id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: number;
  mode?: "text" | "voice";
  idempotencyKey?: string;
}

interface TerminalPaneProps {
  sessionId: Id<"sessions">;
  displayInstance?: DisplayInstance | null;
  messages: Message[];
  input: string;
  onInputChange: (value: string) => void;
  onSend: () => void;
  isLoading: boolean;
}

export const TerminalPane = forwardRef<HTMLTextAreaElement, TerminalPaneProps>(
  function TerminalPane(
    { sessionId, displayInstance, messages, input, onInputChange, onSend, isLoading },
    ref
  ) {
    const containerRef = useRef<HTMLDivElement>(null);
    const shiftHeld = useAtomValue(shiftHeldAtom);
    const [isLiveMode, setIsLiveMode] = useAtom(isLiveModeAtom);
    const [isCameraEnabled, setIsCameraEnabled] = useAtom(isCameraEnabledAtom);
    const room = useAtomValue(liveKitRoomAtom);
    const voiceConnectionStatus = useAtomValue(voiceConnectionStatusAtom);
    const voiceAgentConnected = useAtomValue(voiceAgentConnectedAtom);

    // Camera preview
    const previewVideoRef = useRef<HTMLVideoElement>(null);
    const previewTrackRef = useRef<any>(null);

    const getActiveDisplayInstance = (instance: DisplayInstance): DisplayInstance => {
      if (!instance.children || instance.children.length === 0) return instance;
      const lastChild = instance.children[instance.children.length - 1];
      if (!lastChild) return instance;
      return getActiveDisplayInstance(lastChild);
    };

    const liveModePackEnabled = (() => {
      if (!displayInstance) return undefined;
      const active = getActiveDisplayInstance(displayInstance);
      return active.node.packNames?.includes("liveMode") === true;
    })();
    const liveModeAllowed = liveModePackEnabled === true;

    // If live mode isn't supported in this node, force-disable mic/camera so the UI doesn't get stuck.
    useEffect(() => {
      if (liveModePackEnabled === false) {
        if (isLiveMode) setIsLiveMode(false);
        if (isCameraEnabled) setIsCameraEnabled(false);
      }
    }, [liveModePackEnabled, isLiveMode, isCameraEnabled, setIsLiveMode, setIsCameraEnabled]);

    const detachCameraPreview = useCallback(() => {
      const video = previewVideoRef.current;
      const track = previewTrackRef.current;
      if (video && track && typeof track.detach === "function") {
        try {
          track.detach(video);
        } catch {
          // ignore
        }
      }
      previewTrackRef.current = null;
      if (video) {
        video.srcObject = null;
      }
    }, []);

    const attachCameraPreview = useCallback(() => {
      const video = previewVideoRef.current;
      if (!video || !room) return;

      const pub = room.localParticipant?.getTrackPublication(Track.Source.Camera);
      const track = pub?.track as any;
      if (!track || typeof track.attach !== "function") {
        detachCameraPreview();
        return;
      }

      if (previewTrackRef.current && previewTrackRef.current !== track) {
        try {
          previewTrackRef.current.detach(video);
        } catch {
          // ignore
        }
      }

      previewTrackRef.current = track;
      try {
        track.attach(video);
      } catch {
        // ignore
      }
    }, [room, detachCameraPreview]);

    useEffect(() => {
      if (!liveModeAllowed || !isCameraEnabled || !room) {
        detachCameraPreview();
        return;
      }

      attachCameraPreview();

      const onLocalTrackPublished = (publication: any) => {
        if (publication?.source === Track.Source.Camera) {
          attachCameraPreview();
        }
      };
      const onLocalTrackUnpublished = (publication: any) => {
        if (publication?.source === Track.Source.Camera) {
          detachCameraPreview();
        }
      };

      room.on(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
      room.on(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);

      return () => {
        room.off(RoomEvent.LocalTrackPublished, onLocalTrackPublished);
        room.off(RoomEvent.LocalTrackUnpublished, onLocalTrackUnpublished);
      };
    }, [room, liveModeAllowed, isCameraEnabled, attachCameraPreview, detachCameraPreview]);

    const handleToggleLiveMode = () => {
      setIsLiveMode((prev) => !prev);
    };

    const handleToggleCamera = () => {
      setIsCameraEnabled((prev) => !prev);
    };

    // Auto-scroll on any DOM content change (new messages AND streaming deltas),
    // but only if the user was near the bottom before the content changed.
    // We track lastScrollHeight so we can compare against the pre-mutation scroll
    // position — this avoids races between scroll events and MutationObserver.
    useEffect(() => {
      const container = containerRef.current;
      if (!container) return;

      let lastScrollHeight = container.scrollHeight;
      let userNearBottom = true;

      const handleScroll = () => {
        const { scrollTop, scrollHeight, clientHeight } = container;
        userNearBottom = scrollHeight - scrollTop - clientHeight <= 50;
        lastScrollHeight = scrollHeight;
      };

      const observer = new MutationObserver(() => {
        const { scrollTop, scrollHeight, clientHeight } = container;
        // If content grew, check whether we were near the bottom BEFORE the growth.
        const wasNearBottom = scrollHeight > lastScrollHeight
          ? lastScrollHeight - scrollTop - clientHeight <= 50
          : userNearBottom;
        lastScrollHeight = scrollHeight;

        if (wasNearBottom) {
          container.scrollTop = scrollHeight;
          userNearBottom = true;
        }
      });

      container.addEventListener("scroll", handleScroll, { passive: true });
      observer.observe(container, { childList: true, subtree: true, characterData: true });
      return () => {
        container.removeEventListener("scroll", handleScroll);
        observer.disconnect();
      };
    }, []);

    return (
      <div
        tabIndex={0}
        className="h-full flex flex-col bg-terminal-bg relative z-0 pane-focus"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-2 border-b border-terminal-green-dimmer">
          <h1 className="text-terminal-green terminal-glow text-sm font-bold">
            {shiftHeld ? <u>M</u> : "M"}ESSAGES
          </h1>
          <ScanlinesToggle />
        </div>

        {/* Camera preview (top-right) */}
        {liveModeAllowed && isCameraEnabled && (
          <div className="absolute top-12 right-4 z-10 w-32 aspect-video border border-terminal-green-dimmer bg-black/30 overflow-hidden">
            <video
              ref={previewVideoRef}
              muted
              playsInline
              autoPlay
              className="w-full h-full object-cover"
            />
            <div className="absolute bottom-0 left-0 px-1 py-[1px] text-[10px] font-mono text-terminal-green-dim bg-terminal-bg/70 border-t border-terminal-green-dimmer">
              CAM
            </div>
          </div>
        )}

        {/* Messages area with sticky input */}
        <div
          ref={containerRef}
          className="flex-1 overflow-y-auto p-4 pb-0 terminal-scrollbar"
        >
          {/* Messages with reserved spinner space */}
          <div className="relative pb-8">
            {messages.length === 0 ? (
              <div className="text-terminal-green-dimmer italic">
                Waiting for input...
              </div>
            ) : (
              messages.map((msg) => (
                <TerminalMessage
                  key={msg._id}
                  role={msg.role}
                  content={msg.content}
                  idempotencyKey={msg.idempotencyKey}
                />
              ))
            )}
            {/* Spinner in reserved space - absolute to avoid layout shift */}
            <div className="absolute bottom-0 left-0">
              <ThinkingSpinner sessionId={sessionId} />
            </div>
          </div>

          {/* Sticky input inside scrollable area */}
          <TerminalInput
            ref={ref}
            value={input}
            onChange={onInputChange}
            onSend={onSend}
            isLoading={isLoading}
            isLiveMode={liveModeAllowed ? isLiveMode : false}
            isCameraEnabled={liveModeAllowed ? isCameraEnabled : false}
            voiceConnectionStatus={voiceConnectionStatus}
            voiceAgentConnected={voiceAgentConnected}
            onToggleLiveMode={liveModeAllowed ? handleToggleLiveMode : undefined}
            onToggleCamera={liveModeAllowed ? handleToggleCamera : undefined}
          />
        </div>
      </div>
    );
  }
);
