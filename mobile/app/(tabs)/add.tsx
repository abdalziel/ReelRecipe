import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Platform,
  ScrollView,
} from "react-native";
import { useState } from "react";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import * as Clipboard from "expo-clipboard";
import { reelsApi } from "../../lib/api";

const STEPS = [
  { icon: "logo-instagram", label: "Open Instagram and find a cooking reel" },
  { icon: "share-outline", label: 'Tap "Share" then "Copy Link"' },
  { icon: "clipboard-outline", label: "Paste the link below and tap Import" },
];

export default function AddReelScreen() {
  const [url, setUrl] = useState("");
  const [loading, setLoading] = useState(false);

  const handlePasteFromClipboard = async () => {
    const text = await Clipboard.getStringAsync();
    if (text) setUrl(text);
  };

  const handleImport = async () => {
    if (!url.trim()) {
      Alert.alert("Missing URL", "Please paste an Instagram reel URL first.");
      return;
    }
    setLoading(true);
    try {
      const recipe = await reelsApi.process(url.trim());
      Alert.alert(
        "Recipe Saved!",
        `"${recipe.title}" has been extracted and saved.`,
        [
          { text: "View Recipe", onPress: () => router.push(`/recipe/${recipe.id}`) },
          { text: "Add Another", onPress: () => setUrl("") },
        ]
      );
    } catch (e: any) {
      Alert.alert("Import Failed", e.message ?? "Could not process this reel. Make sure the video is public.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "#0f172a" }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.container}>
        {/* Header */}
        <View style={styles.header}>
          <Ionicons name="logo-instagram" size={48} color="#f97316" />
          <Text style={styles.title}>Import a Cooking Reel</Text>
          <Text style={styles.subtitle}>
            Share any Instagram cooking reel and we'll extract the full recipe automatically.
          </Text>
        </View>

        {/* Steps */}
        <View style={styles.steps}>
          {STEPS.map((step, i) => (
            <View key={i} style={styles.step}>
              <View style={styles.stepNum}>
                <Text style={styles.stepNumText}>{i + 1}</Text>
              </View>
              <View style={styles.stepContent}>
                <Ionicons name={step.icon as any} size={18} color="#f97316" />
                <Text style={styles.stepText}>{step.label}</Text>
              </View>
            </View>
          ))}
        </View>

        {/* URL Input */}
        <View style={styles.inputGroup}>
          <Text style={styles.label}>Reel URL</Text>
          <View style={styles.inputRow}>
            <TextInput
              style={styles.input}
              value={url}
              onChangeText={setUrl}
              placeholder="https://www.instagram.com/reel/..."
              placeholderTextColor="#475569"
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="url"
            />
            <TouchableOpacity style={styles.pasteBtn} onPress={handlePasteFromClipboard}>
              <Ionicons name="clipboard-outline" size={20} color="#94a3b8" />
            </TouchableOpacity>
          </View>
        </View>

        {/* Import Button */}
        <TouchableOpacity
          style={[styles.importBtn, loading && styles.importBtnDisabled]}
          onPress={handleImport}
          disabled={loading}
          activeOpacity={0.8}
        >
          {loading ? (
            <View style={styles.loadingRow}>
              <ActivityIndicator color="#fff" size="small" />
              <Text style={styles.importBtnText}>Extracting recipe…</Text>
            </View>
          ) : (
            <View style={styles.loadingRow}>
              <Ionicons name="sparkles" size={20} color="#fff" />
              <Text style={styles.importBtnText}>Import & Extract Recipe</Text>
            </View>
          )}
        </TouchableOpacity>

        {loading && (
          <View style={styles.processingNote}>
            <Ionicons name="information-circle-outline" size={16} color="#64748b" />
            <Text style={styles.processingText}>
              This takes 30–60 seconds — we're downloading the video, transcribing it, and extracting the recipe with AI.
            </Text>
          </View>
        )}

        {/* Divider */}
        <View style={styles.divider}>
          <View style={styles.dividerLine} />
          <Text style={styles.dividerText}>or</Text>
          <View style={styles.dividerLine} />
        </View>

        {/* Bulk import entry point */}
        <TouchableOpacity
          style={styles.bulkBtn}
          onPress={() => router.push("/bulk-import")}
          activeOpacity={0.8}
        >
          <View style={styles.bulkBtnLeft}>
            <Ionicons name="logo-instagram" size={22} color="#e1306c" />
            <View>
              <Text style={styles.bulkBtnTitle}>Bulk Import from Instagram</Text>
              <Text style={styles.bulkBtnSubtitle}>
                Import all your saved cooking reels at once
              </Text>
            </View>
          </View>
          <Ionicons name="chevron-forward" size={18} color="#475569" />
        </TouchableOpacity>
      </ScrollView>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { padding: 24, gap: 24 },
  header: { alignItems: "center", gap: 12, paddingTop: 16 },
  title: { color: "#f8fafc", fontSize: 22, fontWeight: "800" },
  subtitle: { color: "#94a3b8", fontSize: 14, textAlign: "center", lineHeight: 20 },
  steps: { gap: 12 },
  step: { flexDirection: "row", alignItems: "center", gap: 12 },
  stepNum: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: "#1e293b",
    alignItems: "center",
    justifyContent: "center",
  },
  stepNumText: { color: "#f97316", fontWeight: "700", fontSize: 13 },
  stepContent: { flexDirection: "row", alignItems: "center", gap: 8, flex: 1 },
  stepText: { color: "#cbd5e1", fontSize: 14, flex: 1 },
  inputGroup: { gap: 8 },
  label: { color: "#94a3b8", fontSize: 13, fontWeight: "600" },
  inputRow: {
    flexDirection: "row",
    backgroundColor: "#1e293b",
    borderRadius: 10,
    alignItems: "center",
  },
  input: {
    flex: 1,
    color: "#f8fafc",
    fontSize: 14,
    padding: 14,
  },
  pasteBtn: { padding: 14 },
  importBtn: {
    backgroundColor: "#f97316",
    borderRadius: 12,
    padding: 16,
    alignItems: "center",
  },
  importBtnDisabled: { backgroundColor: "#7c3011" },
  importBtnText: { color: "#fff", fontWeight: "700", fontSize: 16, marginLeft: 8 },
  loadingRow: { flexDirection: "row", alignItems: "center" },
  processingNote: {
    flexDirection: "row",
    gap: 8,
    backgroundColor: "#1e293b",
    padding: 12,
    borderRadius: 10,
    alignItems: "flex-start",
  },
  processingText: { color: "#64748b", fontSize: 13, flex: 1, lineHeight: 18 },
  divider: { flexDirection: "row", alignItems: "center", gap: 12 },
  dividerLine: { flex: 1, height: 1, backgroundColor: "#1e293b" },
  dividerText: { color: "#475569", fontSize: 13 },
  bulkBtn: {
    backgroundColor: "#1e293b",
    borderRadius: 12,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  bulkBtnLeft: { flexDirection: "row", alignItems: "center", gap: 12, flex: 1 },
  bulkBtnTitle: { color: "#f8fafc", fontWeight: "600", fontSize: 15 },
  bulkBtnSubtitle: { color: "#64748b", fontSize: 13, marginTop: 2 },
});
