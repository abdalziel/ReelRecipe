import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ScrollView,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  Switch,
} from "react-native";
import { useState, useEffect, useRef } from "react";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { instagramApi, BulkImportStatus } from "../lib/api";

export default function BulkImportScreen() {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [limitEnabled, setLimitEnabled] = useState(false);
  const [limit, setLimit] = useState("50");
  const [status, setStatus] = useState<BulkImportStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const logScrollRef = useRef<ScrollView>(null);

  // Poll status while running
  useEffect(() => {
    if (status?.status === "running") {
      pollRef.current = setInterval(async () => {
        const s = await instagramApi.getStatus();
        setStatus(s);
        if (s.status !== "running") {
          clearInterval(pollRef.current!);
        }
      }, 2000);
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [status?.status]);

  // Auto-scroll log to bottom
  useEffect(() => {
    logScrollRef.current?.scrollToEnd({ animated: true });
  }, [status?.log]);

  // Load current status on mount
  useEffect(() => {
    instagramApi.getStatus().then(setStatus).catch(() => {});
  }, []);

  const handleStart = async () => {
    if (!username.trim() || !password.trim()) {
      Alert.alert("Missing Info", "Enter your Instagram username and password.");
      return;
    }

    Alert.alert(
      "Start Bulk Import",
      `This will scan your Instagram saved posts and import all cooking reels as recipes.\n\nThis may take several minutes depending on how many saved reels you have.`,
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Start Import",
          onPress: async () => {
            setStarting(true);
            try {
              await instagramApi.startBulkImport(
                username.trim(),
                password.trim(),
                limitEnabled ? parseInt(limit) : undefined
              );
              const s = await instagramApi.getStatus();
              setStatus(s);
            } catch (e: any) {
              Alert.alert("Error", e.message);
            } finally {
              setStarting(false);
            }
          },
        },
      ]
    );
  };

  const handleReset = async () => {
    await instagramApi.resetJob();
    setStatus(null);
  };

  const isRunning = status?.status === "running";
  const isDone = status?.status === "done";
  const isError = status?.status === "error";
  const hasRun = isDone || isError;

  const progress =
    status && status.total > 0 ? status.processed / status.total : 0;

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "#0f172a" }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Ionicons name="logo-instagram" size={40} color="#e1306c" />
          <Text style={styles.title}>Bulk Import Saved Reels</Text>
          <Text style={styles.subtitle}>
            Sign in to Instagram and we'll automatically import all your saved cooking reels as recipes.
          </Text>
        </View>

        {/* Security note */}
        <View style={styles.securityNote}>
          <Ionicons name="lock-closed-outline" size={16} color="#64748b" />
          <Text style={styles.securityText}>
            Your credentials are sent directly to your local backend server and never stored or shared.
          </Text>
        </View>

        {!isRunning && !isDone && (
          <>
            {/* Credentials */}
            <View style={styles.inputGroup}>
              <Text style={styles.label}>Instagram Username</Text>
              <TextInput
                style={styles.input}
                value={username}
                onChangeText={setUsername}
                placeholder="your_username"
                placeholderTextColor="#475569"
                autoCapitalize="none"
                autoCorrect={false}
              />
            </View>

            <View style={styles.inputGroup}>
              <Text style={styles.label}>Password</Text>
              <View style={styles.passwordRow}>
                <TextInput
                  style={[styles.input, { flex: 1 }]}
                  value={password}
                  onChangeText={setPassword}
                  placeholder="••••••••"
                  placeholderTextColor="#475569"
                  secureTextEntry={!showPassword}
                  autoCapitalize="none"
                  autoCorrect={false}
                />
                <TouchableOpacity
                  style={styles.eyeBtn}
                  onPress={() => setShowPassword((v) => !v)}
                >
                  <Ionicons
                    name={showPassword ? "eye-off-outline" : "eye-outline"}
                    size={20}
                    color="#64748b"
                  />
                </TouchableOpacity>
              </View>
            </View>

            {/* Limit toggle */}
            <View style={styles.limitRow}>
              <View style={{ flex: 1 }}>
                <Text style={styles.label}>Limit import count</Text>
                <Text style={styles.hint}>Turn off to import all saved reels</Text>
              </View>
              <Switch
                value={limitEnabled}
                onValueChange={setLimitEnabled}
                trackColor={{ false: "#334155", true: "#f97316" }}
                thumbColor="#fff"
              />
            </View>

            {limitEnabled && (
              <View style={styles.inputGroup}>
                <Text style={styles.label}>Max reels to import</Text>
                <TextInput
                  style={[styles.input, { width: 100 }]}
                  value={limit}
                  onChangeText={setLimit}
                  keyboardType="number-pad"
                  placeholder="50"
                  placeholderTextColor="#475569"
                />
              </View>
            )}

            {/* 2FA warning */}
            <View style={styles.warningNote}>
              <Ionicons name="warning-outline" size={16} color="#d97706" />
              <Text style={styles.warningText}>
                If your Instagram account has two-factor authentication enabled, you'll need to temporarily disable it for bulk import to work.
              </Text>
            </View>

            <TouchableOpacity
              style={[styles.startBtn, starting && styles.btnDisabled]}
              onPress={handleStart}
              disabled={starting}
            >
              {starting ? (
                <ActivityIndicator color="#fff" size="small" />
              ) : (
                <>
                  <Ionicons name="cloud-download-outline" size={20} color="#fff" />
                  <Text style={styles.startBtnText}>Start Bulk Import</Text>
                </>
              )}
            </TouchableOpacity>
          </>
        )}

        {/* Progress panel */}
        {(isRunning || hasRun) && status && (
          <View style={styles.progressPanel}>
            {/* Status badge */}
            <View style={styles.statusRow}>
              {isRunning && <ActivityIndicator color="#f97316" size="small" />}
              {isDone && <Ionicons name="checkmark-circle" size={20} color="#16a34a" />}
              {isError && <Ionicons name="close-circle" size={20} color="#ef4444" />}
              <Text
                style={[
                  styles.statusLabel,
                  isDone && { color: "#16a34a" },
                  isError && { color: "#ef4444" },
                ]}
              >
                {isRunning
                  ? `Processing ${status.processed} of ${status.total}…`
                  : isDone
                  ? "Import complete"
                  : "Import failed"}
              </Text>
            </View>

            {/* Progress bar */}
            {status.total > 0 && (
              <View style={styles.progressBar}>
                <View
                  style={[
                    styles.progressFill,
                    { width: `${Math.round(progress * 100)}%` },
                    isDone && { backgroundColor: "#16a34a" },
                  ]}
                />
              </View>
            )}

            {/* Stats */}
            {status.total > 0 && (
              <View style={styles.statsRow}>
                <Stat label="Imported" value={status.imported} color="#16a34a" />
                <Stat label="Skipped" value={status.skipped} color="#64748b" />
                <Stat label="Failed" value={status.failed} color="#ef4444" />
                <Stat label="Total" value={status.total} color="#f97316" />
              </View>
            )}

            {/* Current item */}
            {isRunning && status.current && (
              <Text style={styles.currentItem} numberOfLines={1}>
                Now: {status.current}
              </Text>
            )}

            {/* Log */}
            <Text style={styles.logLabel}>Log</Text>
            <ScrollView
              ref={logScrollRef}
              style={styles.logBox}
              contentContainerStyle={{ padding: 10 }}
              nestedScrollEnabled
            >
              {status.log.map((line, i) => (
                <Text key={i} style={styles.logLine}>
                  {line}
                </Text>
              ))}
            </ScrollView>

            {/* Actions after completion */}
            {hasRun && (
              <View style={styles.doneActions}>
                {isDone && (
                  <TouchableOpacity
                    style={styles.viewRecipesBtn}
                    onPress={() => router.replace("/(tabs)")}
                  >
                    <Ionicons name="restaurant-outline" size={18} color="#fff" />
                    <Text style={styles.viewRecipesBtnText}>
                      View {status.imported} Recipes
                    </Text>
                  </TouchableOpacity>
                )}
                <TouchableOpacity style={styles.resetBtn} onPress={handleReset}>
                  <Text style={styles.resetBtnText}>Run Again</Text>
                </TouchableOpacity>
              </View>
            )}
          </View>
        )}
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

function Stat({
  label,
  value,
  color,
}: {
  label: string;
  value: number;
  color: string;
}) {
  return (
    <View style={{ alignItems: "center", flex: 1 }}>
      <Text style={{ color, fontSize: 20, fontWeight: "800" }}>{value}</Text>
      <Text style={{ color: "#64748b", fontSize: 12 }}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { padding: 20, gap: 20, paddingBottom: 40 },
  header: { alignItems: "center", gap: 10, paddingTop: 8 },
  title: { color: "#f8fafc", fontSize: 20, fontWeight: "800" },
  subtitle: { color: "#94a3b8", fontSize: 14, textAlign: "center", lineHeight: 20 },
  securityNote: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 12,
    alignItems: "flex-start",
  },
  securityText: { color: "#64748b", fontSize: 13, flex: 1, lineHeight: 18 },
  warningNote: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: "#1c1407",
    borderRadius: 10,
    padding: 12,
    alignItems: "flex-start",
    borderWidth: 1,
    borderColor: "#78350f",
  },
  warningText: { color: "#d97706", fontSize: 13, flex: 1, lineHeight: 18 },
  inputGroup: { gap: 6 },
  label: { color: "#94a3b8", fontSize: 13, fontWeight: "600" },
  hint: { color: "#475569", fontSize: 12 },
  input: {
    backgroundColor: "#1e293b",
    borderRadius: 10,
    color: "#f8fafc",
    fontSize: 15,
    padding: 14,
  },
  passwordRow: { flexDirection: "row", gap: 4, alignItems: "center" },
  eyeBtn: { padding: 14, backgroundColor: "#1e293b", borderRadius: 10 },
  limitRow: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 14,
    gap: 12,
  },
  startBtn: {
    backgroundColor: "#e1306c",
    borderRadius: 12,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  btnDisabled: { opacity: 0.5 },
  startBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  progressPanel: { backgroundColor: "#1e293b", borderRadius: 14, padding: 16, gap: 12 },
  statusRow: { flexDirection: "row", alignItems: "center", gap: 8 },
  statusLabel: { color: "#f8fafc", fontWeight: "700", fontSize: 15, flex: 1 },
  progressBar: { height: 6, backgroundColor: "#0f172a", borderRadius: 3 },
  progressFill: { height: 6, backgroundColor: "#f97316", borderRadius: 3 },
  statsRow: { flexDirection: "row", paddingVertical: 4 },
  currentItem: { color: "#64748b", fontSize: 13 },
  logLabel: { color: "#475569", fontSize: 12, fontWeight: "600" },
  logBox: { backgroundColor: "#0f172a", borderRadius: 8, maxHeight: 220 },
  logLine: { color: "#64748b", fontSize: 12, lineHeight: 18, fontFamily: "monospace" },
  doneActions: { gap: 8 },
  viewRecipesBtn: {
    backgroundColor: "#16a34a",
    borderRadius: 10,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  viewRecipesBtnText: { color: "#fff", fontWeight: "700" },
  resetBtn: {
    borderWidth: 1,
    borderColor: "#334155",
    borderRadius: 10,
    padding: 14,
    alignItems: "center",
  },
  resetBtnText: { color: "#94a3b8", fontWeight: "600" },
});
