import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  TextInput,
  Alert,
  ActivityIndicator,
  KeyboardAvoidingView,
  Platform,
  Modal,
} from "react-native";
import { useState, useEffect } from "react";
import { Ionicons } from "@expo/vector-icons";
import * as DocumentPicker from "expo-document-picker";
import { dietApi, DietPlan } from "../../lib/api";

type InputMode = "type" | "pdf";

export default function DietScreen() {
  const [activePlan, setActivePlan] = useState<DietPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [inputMode, setInputMode] = useState<InputMode>("type");
  const [description, setDescription] = useState("");
  const [planName, setPlanName] = useState("My Diet Plan");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    dietApi
      .getActive()
      .then(setActivePlan)
      .catch(() => setActivePlan(null))
      .finally(() => setLoading(false));
  }, []);

  const handleSubmitText = async () => {
    if (!description.trim()) {
      Alert.alert("Missing Info", "Please describe your diet goals.");
      return;
    }
    setSubmitting(true);
    try {
      const plan = await dietApi.fromText(description, planName);
      setActivePlan(plan);
      setShowForm(false);
      setDescription("");
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleUploadPdf = async () => {
    const result = await DocumentPicker.getDocumentAsync({
      type: "application/pdf",
      copyToCacheDirectory: true,
    });
    if (result.canceled) return;
    const file = result.assets[0];
    setSubmitting(true);
    try {
      const plan = await dietApi.fromPdf(file.uri, planName);
      setActivePlan(plan);
      setShowForm(false);
    } catch (e: any) {
      Alert.alert("Error", e.message);
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!activePlan) return;
    Alert.alert("Remove Diet Plan", "Delete your current diet plan?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await dietApi.delete(activePlan.id);
          setActivePlan(null);
        },
      },
    ]);
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#f97316" size="large" />
      </View>
    );
  }

  return (
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: "#0f172a" }}
      behavior={Platform.OS === "ios" ? "padding" : undefined}
    >
      <ScrollView contentContainerStyle={styles.container}>
        {activePlan ? (
          <>
            {/* Active plan card */}
            <View style={styles.planCard}>
              <View style={styles.planCardHeader}>
                <Ionicons name="fitness" size={24} color="#f97316" />
                <View style={{ flex: 1 }}>
                  <Text style={styles.planName}>{activePlan.name}</Text>
                  {activePlan.diet_type && (
                    <Text style={styles.planType}>{activePlan.diet_type}</Text>
                  )}
                </View>
                <TouchableOpacity onPress={handleDelete}>
                  <Ionicons name="trash-outline" size={20} color="#64748b" />
                </TouchableOpacity>
              </View>

              {activePlan.goals && (
                <Text style={styles.goalsText}>{activePlan.goals}</Text>
              )}

              {/* Daily targets */}
              <View style={styles.targetsGrid}>
                <MacroTarget
                  label="Calories"
                  value={activePlan.daily_targets.calories}
                  unit=""
                  color="#f97316"
                />
                <MacroTarget
                  label="Protein"
                  value={activePlan.daily_targets.protein_g}
                  unit="g"
                  color="#ef4444"
                />
                <MacroTarget
                  label="Carbs"
                  value={activePlan.daily_targets.carbs_g}
                  unit="g"
                  color="#eab308"
                />
                <MacroTarget
                  label="Fat"
                  value={activePlan.daily_targets.fat_g}
                  unit="g"
                  color="#3b82f6"
                />
              </View>
            </View>

            {/* Per-meal targets */}
            {activePlan.meal_targets && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Per-Meal Targets</Text>
                {Object.entries(activePlan.meal_targets).map(([slot, targets]) => (
                  <View key={slot} style={styles.mealTargetRow}>
                    <Text style={styles.mealTargetSlot}>
                      {slot.charAt(0).toUpperCase() + slot.slice(1)}
                    </Text>
                    <View style={styles.mealTargetMacros}>
                      {targets.calories != null && (
                        <Text style={styles.mealMacro}>{Math.round(targets.calories)} cal</Text>
                      )}
                      {targets.protein_g != null && (
                        <Text style={styles.mealMacro}>{Math.round(targets.protein_g)}g P</Text>
                      )}
                      {targets.carbs_g != null && (
                        <Text style={styles.mealMacro}>{Math.round(targets.carbs_g)}g C</Text>
                      )}
                      {targets.fat_g != null && (
                        <Text style={styles.mealMacro}>{Math.round(targets.fat_g)}g F</Text>
                      )}
                    </View>
                  </View>
                ))}
              </View>
            )}

            {/* Restrictions */}
            {activePlan.restrictions?.length > 0 && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Dietary Restrictions</Text>
                <View style={styles.tagsRow}>
                  {activePlan.restrictions.map((r) => (
                    <View key={r} style={styles.restrictionTag}>
                      <Text style={styles.restrictionText}>{r}</Text>
                    </View>
                  ))}
                </View>
              </View>
            )}

            {/* Full analysis */}
            {activePlan.analysis && (
              <View style={styles.section}>
                <Text style={styles.sectionTitle}>Analysis</Text>
                <Text style={styles.analysisText}>{activePlan.analysis}</Text>
              </View>
            )}

            <TouchableOpacity
              style={styles.updateBtn}
              onPress={() => setShowForm(true)}
            >
              <Ionicons name="refresh-outline" size={18} color="#fff" />
              <Text style={styles.updateBtnText}>Update Diet Plan</Text>
            </TouchableOpacity>
          </>
        ) : (
          /* No plan — onboarding */
          <View style={styles.onboarding}>
            <Ionicons name="fitness-outline" size={64} color="#334155" />
            <Text style={styles.onboardingTitle}>Set Your Diet Goals</Text>
            <Text style={styles.onboardingSubtitle}>
              Describe your goals or upload a diet plan. Claude will analyze it and align your meals accordingly.
            </Text>
            <TouchableOpacity
              style={styles.setupBtn}
              onPress={() => setShowForm(true)}
            >
              <Ionicons name="add-circle-outline" size={20} color="#fff" />
              <Text style={styles.setupBtnText}>Set Up Diet Plan</Text>
            </TouchableOpacity>
          </View>
        )}
      </ScrollView>

      {/* Form Modal */}
      <Modal
        visible={showForm}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowForm(false)}
      >
        <KeyboardAvoidingView
          style={{ flex: 1, backgroundColor: "#0f172a" }}
          behavior={Platform.OS === "ios" ? "padding" : undefined}
        >
          <ScrollView contentContainerStyle={styles.formContainer}>
            <View style={styles.formHeader}>
              <Text style={styles.formTitle}>Diet Plan</Text>
              <TouchableOpacity onPress={() => setShowForm(false)}>
                <Ionicons name="close" size={24} color="#94a3b8" />
              </TouchableOpacity>
            </View>

            {/* Name */}
            <View style={styles.inputGroup}>
              <Text style={styles.inputLabel}>Plan Name</Text>
              <TextInput
                style={styles.textInput}
                value={planName}
                onChangeText={setPlanName}
                placeholder="My Diet Plan"
                placeholderTextColor="#475569"
              />
            </View>

            {/* Mode toggle */}
            <View style={styles.modeToggle}>
              <TouchableOpacity
                style={[styles.modeBtn, inputMode === "type" && styles.modeBtnActive]}
                onPress={() => setInputMode("type")}
              >
                <Ionicons name="create-outline" size={16} color={inputMode === "type" ? "#fff" : "#94a3b8"} />
                <Text style={[styles.modeBtnText, inputMode === "type" && styles.modeBtnTextActive]}>
                  Type Goals
                </Text>
              </TouchableOpacity>
              <TouchableOpacity
                style={[styles.modeBtn, inputMode === "pdf" && styles.modeBtnActive]}
                onPress={() => setInputMode("pdf")}
              >
                <Ionicons name="document-outline" size={16} color={inputMode === "pdf" ? "#fff" : "#94a3b8"} />
                <Text style={[styles.modeBtnText, inputMode === "pdf" && styles.modeBtnTextActive]}>
                  Upload PDF
                </Text>
              </TouchableOpacity>
            </View>

            {inputMode === "type" ? (
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Describe your diet goals</Text>
                <TextInput
                  style={[styles.textInput, styles.textArea]}
                  value={description}
                  onChangeText={setDescription}
                  placeholder={
                    "e.g. I'm trying to build muscle and lose fat. I need about 2400 calories a day with at least 180g of protein. I eat 3 meals and 1-2 snacks. I don't eat gluten or dairy..."
                  }
                  placeholderTextColor="#475569"
                  multiline
                  numberOfLines={8}
                  textAlignVertical="top"
                />
                <TouchableOpacity
                  style={[styles.submitBtn, submitting && styles.submitBtnDisabled]}
                  onPress={handleSubmitText}
                  disabled={submitting}
                >
                  {submitting ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="sparkles" size={18} color="#fff" />
                      <Text style={styles.submitBtnText}>Analyze & Save</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            ) : (
              <View style={styles.inputGroup}>
                <Text style={styles.inputLabel}>Upload a PDF diet plan</Text>
                <Text style={styles.inputHint}>
                  MyFitnessPal exports, PDF nutrition plans, or any document describing your targets all work.
                </Text>
                <TouchableOpacity
                  style={[styles.pdfBtn, submitting && styles.submitBtnDisabled]}
                  onPress={handleUploadPdf}
                  disabled={submitting}
                >
                  {submitting ? (
                    <ActivityIndicator color="#fff" size="small" />
                  ) : (
                    <>
                      <Ionicons name="cloud-upload-outline" size={20} color="#fff" />
                      <Text style={styles.submitBtnText}>Choose PDF & Analyze</Text>
                    </>
                  )}
                </TouchableOpacity>
              </View>
            )}
          </ScrollView>
        </KeyboardAvoidingView>
      </Modal>
    </KeyboardAvoidingView>
  );
}

function MacroTarget({
  label,
  value,
  unit,
  color,
}: {
  label: string;
  value?: number | null;
  unit: string;
  color: string;
}) {
  if (value == null) return null;
  return (
    <View style={macroStyles.item}>
      <Text style={[macroStyles.value, { color }]}>
        {Math.round(value)}{unit}
      </Text>
      <Text style={macroStyles.label}>{label}</Text>
    </View>
  );
}

const macroStyles = StyleSheet.create({
  item: { alignItems: "center", flex: 1 },
  value: { fontSize: 20, fontWeight: "800" },
  label: { color: "#64748b", fontSize: 12, marginTop: 2 },
});

const styles = StyleSheet.create({
  container: { padding: 16, gap: 16, paddingBottom: 40 },
  center: { flex: 1, backgroundColor: "#0f172a", alignItems: "center", justifyContent: "center" },
  planCard: { backgroundColor: "#1e293b", borderRadius: 16, padding: 16, gap: 12 },
  planCardHeader: { flexDirection: "row", alignItems: "center", gap: 12 },
  planName: { color: "#f8fafc", fontSize: 17, fontWeight: "700" },
  planType: { color: "#94a3b8", fontSize: 13 },
  goalsText: { color: "#cbd5e1", fontSize: 14, lineHeight: 20 },
  targetsGrid: { flexDirection: "row", paddingTop: 8 },
  section: { backgroundColor: "#1e293b", borderRadius: 14, padding: 16, gap: 8 },
  sectionTitle: { color: "#f8fafc", fontSize: 16, fontWeight: "700" },
  mealTargetRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingVertical: 6,
    borderBottomWidth: 1,
    borderBottomColor: "#0f172a",
  },
  mealTargetSlot: { color: "#f8fafc", fontSize: 14, fontWeight: "600", width: 80 },
  mealTargetMacros: { flexDirection: "row", gap: 10 },
  mealMacro: { color: "#64748b", fontSize: 12 },
  tagsRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  restrictionTag: {
    backgroundColor: "#0f172a",
    borderRadius: 20,
    paddingHorizontal: 12,
    paddingVertical: 4,
  },
  restrictionText: { color: "#94a3b8", fontSize: 13 },
  analysisText: { color: "#94a3b8", fontSize: 14, lineHeight: 20 },
  updateBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 14,
  },
  updateBtnText: { color: "#fff", fontWeight: "600" },
  onboarding: { alignItems: "center", paddingTop: 60, gap: 16 },
  onboardingTitle: { color: "#f8fafc", fontSize: 22, fontWeight: "800" },
  onboardingSubtitle: { color: "#94a3b8", fontSize: 14, textAlign: "center", lineHeight: 20 },
  setupBtn: {
    marginTop: 8,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    backgroundColor: "#f97316",
    borderRadius: 12,
    paddingHorizontal: 24,
    paddingVertical: 14,
  },
  setupBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  formContainer: { padding: 20, gap: 20, paddingBottom: 40 },
  formHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
  formTitle: { color: "#f8fafc", fontSize: 20, fontWeight: "700" },
  inputGroup: { gap: 8 },
  inputLabel: { color: "#94a3b8", fontSize: 13, fontWeight: "600" },
  inputHint: { color: "#475569", fontSize: 13, lineHeight: 18 },
  textInput: {
    backgroundColor: "#1e293b",
    borderRadius: 10,
    color: "#f8fafc",
    fontSize: 15,
    padding: 14,
  },
  textArea: { minHeight: 160, lineHeight: 22 },
  modeToggle: {
    flexDirection: "row",
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 4,
    gap: 4,
  },
  modeBtn: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    borderRadius: 8,
  },
  modeBtnActive: { backgroundColor: "#f97316" },
  modeBtnText: { color: "#94a3b8", fontWeight: "600", fontSize: 14 },
  modeBtnTextActive: { color: "#fff" },
  submitBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#f97316",
    borderRadius: 10,
    padding: 16,
  },
  pdfBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    backgroundColor: "#7c3aed",
    borderRadius: 10,
    padding: 16,
  },
  submitBtnDisabled: { opacity: 0.5 },
  submitBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
});
