"use client";

import { useEffect, useRef, useCallback, useImperativeHandle, forwardRef } from "react";
import { useAtom, useSetAtom } from "jotai";
import { useAction } from "convex/react";
import { Room, RoomEvent, Track, ConnectionState, ParticipantKind } from "livekit-client";
import { api } from "@/convex/_generated/api";
import { useMutation } from "convex/react";
import type { Id } from "@/convex/_generated/dataModel";
import { isLiveModeAtom, voiceConnectionStatusAtom, voiceAgentConnectedAtom } from "@/src/atoms";

interface LiveVoiceClientProps {
  sessionId: Id<"sessions">;
}

export interface LiveVoiceClientHandle {
  sendMessage: (message: string) => Promise<{ response: string; instance: unknown } | null>;
  executeCommand: (commandName: string, input: Record<string, unknown>) => Promise<{ accepted: boolean; command?: string; error?: string }>;
  isConnected: () => boolean;
}

/**
 * LiveVoiceClient manages the LiveKit connection for the agent.
 *
 * Always connects to the LiveKit room (for RPC text messages).
 * When live mode is enabled, also enables microphone for voice input.
 *
 * 1. Fetches a LiveKit token from Convex on mount
 * 2. Connects to the LiveKit room
 * 3. In live mode: Publishes user microphone, subscribes to agent audio
 * 4. Exposes sendMessage() for text messages via RPC
 *
 * Transcripts are persisted by the voice agent directly to Convex.
 */
export const LiveVoiceClient = forwardRef<LiveVoiceClientHandle, LiveVoiceClientProps>(
  function LiveVoiceClient({ sessionId }, ref) {
    const [isLiveMode, setIsLiveMode] = useAtom(isLiveModeAtom);
    const setConnectionStatus = useSetAtom(voiceConnectionStatusAtom);
    const setAgentConnected = useSetAtom(voiceAgentConnectedAtom);
    const getToken = useAction(api.livekitAgentActions.getToken);
    const forceDispatch = useAction(api.agentWatchdog.forceDispatch);

    const roomRef = useRef<Room | null>(null);
    const audioElementRef = useRef<HTMLAudioElement | null>(null);
    const hasConnectedRef = useRef(false);
    const agentCheckTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

    // Check if any agent is in the room
    const checkForAgent = useCallback((room: Room): boolean => {
      const hasAgent = Array.from(room.remoteParticipants.values()).some(
        (p) => p.kind === ParticipantKind.AGENT
      );
      setAgentConnected(hasAgent);
      return hasAgent;
    }, [setAgentConnected]);

    // Cleanup function
    const cleanup = useCallback(async () => {
      if (agentCheckTimeoutRef.current) {
        clearTimeout(agentCheckTimeoutRef.current);
        agentCheckTimeoutRef.current = null;
      }
      if (roomRef.current) {
        await roomRef.current.disconnect();
        roomRef.current = null;
      }
      if (audioElementRef.current) {
        audioElementRef.current.srcObject = null;
      }
      setConnectionStatus("disconnected");
      setAgentConnected(false);
      hasConnectedRef.current = false;
    }, [setConnectionStatus, setAgentConnected]);

    // Connect to LiveKit room
    const connect = useCallback(async () => {
      if (roomRef.current || hasConnectedRef.current) {
        return; // Already connected or connecting
      }
      hasConnectedRef.current = true;

      setConnectionStatus("connecting");

      try {
        // Get token from Convex
        const { token, url, room: roomName } = await getToken({ sessionId });

        // Create and connect room
        const room = new Room({
          adaptiveStream: true,
          dynacast: true,
        });

        roomRef.current = room;

        // Handle connection state changes
        room.on(RoomEvent.ConnectionStateChanged, (state) => {
          if (state === ConnectionState.Connected) {
            setConnectionStatus("connected");
          } else if (state === ConnectionState.Disconnected) {
            setConnectionStatus("disconnected");
          }
        });

        // Handle agent audio track subscription
        room.on(RoomEvent.TrackSubscribed, (track, publication, participant) => {
          if (track.kind === Track.Kind.Audio && !participant.isLocal) {
            // Create audio element for agent audio
            if (!audioElementRef.current) {
              audioElementRef.current = document.createElement("audio");
              audioElementRef.current.autoplay = true;
              document.body.appendChild(audioElementRef.current);
            }
            track.attach(audioElementRef.current);
          }
        });

        // Handle track unsubscription
        room.on(RoomEvent.TrackUnsubscribed, (track) => {
          if (track.kind === Track.Kind.Audio && audioElementRef.current) {
            track.detach(audioElementRef.current);
          }
        });

        // Handle disconnection
        room.on(RoomEvent.Disconnected, () => {
          setConnectionStatus("disconnected");
          setAgentConnected(false);
        });

        // Handle participant connections (to detect agent)
        room.on(RoomEvent.ParticipantConnected, (participant) => {
          if (participant.kind === ParticipantKind.AGENT) {
            setAgentConnected(true);
          }
        });

        // Handle participant disconnections
        room.on(RoomEvent.ParticipantDisconnected, (participant) => {
          if (participant.kind === ParticipantKind.AGENT) {
            const stillHasAgent = checkForAgent(room); // Check if any other agents remain
            
            // If agent disconnected and no other agent, schedule a retry dispatch
            if (!stillHasAgent) {
              console.log("[LiveVoiceClient] Agent disconnected, scheduling retry dispatch");
              agentCheckTimeoutRef.current = setTimeout(async () => {
                // Check again before dispatching
                if (roomRef.current) {
                  const hasAgentNow = Array.from(roomRef.current.remoteParticipants.values()).some(
                    (p) => p.kind === ParticipantKind.AGENT
                  );
                  if (!hasAgentNow) {
                    console.log("[LiveVoiceClient] Still no agent, triggering force dispatch");
                    try {
                      await forceDispatch({ roomName });
                    } catch (e) {
                      console.error("[LiveVoiceClient] Force dispatch failed:", e);
                    }
                  }
                }
              }, 5000); // Wait 5s before force dispatch
            }
          }
        });

        // Connect to room
        await room.connect(url, token);

        // Check for existing agent in the room
        const hasAgent = checkForAgent(room);
        
        // If no agent after initial connection, schedule a check to trigger dispatch
        if (!hasAgent) {
          console.log("[LiveVoiceClient] No agent on connect, scheduling check");
          agentCheckTimeoutRef.current = setTimeout(async () => {
            if (roomRef.current) {
              const hasAgentNow = Array.from(roomRef.current.remoteParticipants.values()).some(
                (p) => p.kind === ParticipantKind.AGENT
              );
              if (!hasAgentNow) {
                console.log("[LiveVoiceClient] Still no agent after 10s, triggering force dispatch");
                try {
                  await forceDispatch({ roomName });
                } catch (e) {
                  console.error("[LiveVoiceClient] Force dispatch failed:", e);
                }
              }
            }
          }, 10000); // Wait 10s for agent to connect normally
        }

        setConnectionStatus("connected");
      } catch (error) {
        console.error("Failed to connect to voice room:", error);
        setConnectionStatus("disconnected");
        hasConnectedRef.current = false;
      }
    }, [sessionId, getToken, setConnectionStatus, setAgentConnected, checkForAgent, forceDispatch]);

    // Always connect when component mounts with a valid session
    useEffect(() => {
      connect();

      return () => {
        cleanup();
      };
    }, [connect, cleanup]);

    // Toggle microphone based on live mode
    useEffect(() => {
      const room = roomRef.current;
      if (!room || room.state !== ConnectionState.Connected) return;

      // Enable/disable microphone based on live mode
      room.localParticipant.setMicrophoneEnabled(isLiveMode).catch((error) => {
        console.error("Failed to toggle microphone:", error);
      });

      // Also notify agent of mode change via RPC
      const agentParticipant = Array.from(room.remoteParticipants.values()).find(
        (p) => p.kind === ParticipantKind.AGENT
      );

      if (agentParticipant) {
        room.localParticipant
          .performRpc({
            destinationIdentity: agentParticipant.identity,
            method: "setLiveMode",
            payload: isLiveMode ? "true" : "false",
            responseTimeout: 5000,
          })
          .catch((error) => {
            console.error("Failed to notify agent of mode change:", error);
          });
      }
    }, [isLiveMode]);

    // Cleanup audio element on unmount
    useEffect(() => {
      return () => {
        if (audioElementRef.current) {
          audioElementRef.current.remove();
          audioElementRef.current = null;
        }
      };
    }, []);

    // Send a text message to the agent via RPC
    const sendMessage = useCallback(
      async (message: string): Promise<{ response: string; instance: unknown } | null> => {
        const room = roomRef.current;
        if (!room || room.state !== ConnectionState.Connected) {
          console.error("Cannot send message: room not connected");
          return null;
        }

        // Find the agent participant
        const agentParticipant = Array.from(room.remoteParticipants.values()).find(
          (p) => p.kind === ParticipantKind.AGENT
        );

        if (!agentParticipant) {
          console.error("Cannot send message: no agent in room");
          return null;
        }

        try {
          const response = await room.localParticipant.performRpc({
            destinationIdentity: agentParticipant.identity,
            method: "sendMessage",
            payload: message,
            responseTimeout: 60000, // 60s timeout for LLM response
          });

          return JSON.parse(response);
        } catch (error) {
          console.error("RPC sendMessage failed:", error);
          throw error;
        }
      },
      []
    );

    // Execute a command on the agent via RPC
    const executeCommand = useCallback(
      async (commandName: string, input: Record<string, unknown>): Promise<{ accepted: boolean; command?: string; error?: string }> => {
        const room = roomRef.current;
        if (!room || room.state !== ConnectionState.Connected) {
          console.error("Cannot execute command: room not connected");
          return { accepted: false, error: "Not connected to agent" };
        }

        // Find the agent participant
        const agentParticipant = Array.from(room.remoteParticipants.values()).find(
          (p) => p.kind === ParticipantKind.AGENT
        );

        if (!agentParticipant) {
          console.error("Cannot execute command: no agent in room");
          return { accepted: false, error: "No agent in room" };
        }

        try {
          const response = await room.localParticipant.performRpc({
            destinationIdentity: agentParticipant.identity,
            method: "executeCommand",
            payload: JSON.stringify({ commandName, input }),
            responseTimeout: 30000, // 30s timeout for command execution
          });

          return JSON.parse(response) as { accepted: boolean; command?: string; error?: string };
        } catch (error) {
          console.error("RPC executeCommand failed:", error);
          return { accepted: false, error: error instanceof Error ? error.message : "Unknown error" };
        }
      },
      []
    );

    // Expose methods via ref
    useImperativeHandle(
      ref,
      () => ({
        sendMessage,
        executeCommand,
        isConnected: () => roomRef.current?.state === ConnectionState.Connected,
      }),
      [sendMessage, executeCommand]
    );

    // This component doesn't render anything visible
    return null;
  }
);
