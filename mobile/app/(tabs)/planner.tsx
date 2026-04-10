import {
  View,
  Text,
  ScrollView,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ActivityIndicator,
  Modal,
  FlatList,
} from "react-native";
import { useState, useEffect, useCallback } from "react";
import { Ionicons } from "@expo/vector-icons";
import { mealPlanApi, recipesApi, dietApi, shoppingApi, MealPlan, Recipe, DietPlan } from "../../lib/api";
import { router } from "expo-router";

const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const SLOTS = ["breakfast", "lunch", "dinner", "snack"];
const SLOT_ICONS: Record<string, string> = {
  breakfast: "sunny-outline",
  lunch: "partly-sunny-outline",
  dinner: "moon-outline",
  snack: "nutrition-outline",
};

function getMondayOfCurrentWeek(): string {
  const now = new Date();
  const day = now.getDay();
  const diff = now.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(now.setDate(diff));
  return monday.toISOString().split("T")[0];
}

export default function PlannerScreen() {
  const [plan, setPlan] = useState<MealPlan | null>(null);
  const [loading, setLoading] = useState(true);
  const [aiLoading, setAiLoading] = useState(false);
  const [showRecipePicker, setShowRecipePicker] = useState(false);
  const [pickerTarget, setPickerTarget] = useState<{ day: number; slot: string } | null>(null);
  const [allRecipes, setAllRecipes] = useState<Recipe[]>([]);
  const [activeDiet, setActiveDiet] = useState<DietPlan | null>(null);

  const loadPlan = useCallback(async () => {
    try {
      const plans = await mealPlanApi.list();
      if (plans.length > 0) {
        setPlan(plans[0]);
      } else {
        const newPlan = await mealPlanApi.create({
          name: "This Week",
          week_start: getMondayOfCurrentWeek(),
        });
        setPlan(newPlan);
      }
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPlan();
    recipesApi.list().then(setAllRecipes).catch(() => {});
    dietApi.getActive().then(setActiveDiet).catch(() => {});
  }, [loadPlan]);

  const handleAiAlign = async () => {
    if (!plan || !activeDiet) {
      Alert.alert("No Diet Plan", "Add a diet plan in the Diet Goals tab first.");
      return;
    }
    Alert.alert(
      "AI Meal Alignment",
      "Claude will fill your week with recipes that best match your diet goals. Current entries will be replaced.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Align",
          onPress: async () => {
            setAiLoading(true);
            try {
              const updated = await mealPlanApi.aiAlign(plan.id, activeDiet.id);
              setPlan(updated);
            } catch (e: any) {
              Alert.alert("Error", e.message);
            } finally {
              setAiLoading(false);
            }
          },
        },
      ]
    );
  };

  const handleAddMeal = (dayIndex: number, slot: string) => {
    setPickerTarget({ day: dayIndex, slot });
    setShowRecipePicker(true);
  };

  const handlePickRecipe = async (recipe: Recipe) => {
    if (!plan || !pickerTarget) return;
    setShowRecipePicker(false);
    try {
      const updated = await mealPlanApi.addEntry(plan.id, {
        recipe_id: recipe.id,
        day_of_week: pickerTarget.day,
        meal_slot: pickerTarget.slot,
        servings: 1,
      });
      // Refresh plan
      const fresh = await mealPlanApi.get(plan.id);
      setPlan(fresh);
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
  };

  const handleRemoveEntry = async (entryId: number) => {
    if (!plan) return;
    try {
      await mealPlanApi.removeEntry(plan.id, entryId);
      const fresh = await mealPlanApi.get(plan.id);
      setPlan(fresh);
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
  };

  const handleGenerateShopping = async () => {
    if (!plan) return;
    try {
      const lists = await shoppingApi.generateFromPlan({
        meal_plan_id: plan.id,
        name: "Weekly Shopping",
        grocery_runs: 1,
      });
      Alert.alert("Shopping List Created", `Generated ${lists.length} list(s).`, [
        { text: "View", onPress: () => router.push("/(tabs)/shopping") },
        { text: "OK" },
      ]);
    } catch (e: any) {
      Alert.alert("Error", e.message);
    }
  };

  if (loading) {
    return (
      <View style={styles.center}>
        <ActivityIndicator color="#f97316" size="large" />
      </View>
    );
  }

  return (
    <View style={styles.container}>
      {/* Header actions */}
      <View style={styles.headerRow}>
        <Text style={styles.weekLabel}>
          Week of {plan?.week_start ?? ""}
        </Text>
        <TouchableOpacity
          style={[styles.aiBtn, aiLoading && styles.aiBtnDisabled]}
          onPress={handleAiAlign}
          disabled={aiLoading}
        >
          {aiLoading ? (
            <ActivityIndicator color="#fff" size="small" />
          ) : (
            <>
              <Ionicons name="sparkles" size={16} color="#fff" />
              <Text style={styles.aiBtnText}>AI Align</Text>
            </>
          )}
        </TouchableOpacity>
      </View>

      <ScrollView contentContainerStyle={styles.calendar}>
        {DAYS.map((dayName, dayIndex) => {
          const dayData = plan?.calendar[dayIndex];
          return (
            <View key={dayIndex} style={styles.dayBlock}>
              <Text style={styles.dayLabel}>{dayName}</Text>
              {SLOTS.map((slot) => {
                const entries = dayData?.meals[slot] ?? [];
                return (
                  <View key={slot} style={styles.slotBlock}>
                    <View style={styles.slotHeader}>
                      <Ionicons
                        name={SLOT_ICONS[slot] as any}
                        size={14}
                        color="#64748b"
                      />
                      <Text style={styles.slotLabel}>{slot}</Text>
                    </View>
                    {entries.map((entry) => (
                      <View key={entry.id} style={styles.entryCard}>
                        <Text style={styles.entryTitle} numberOfLines={1}>
                          {entry.recipe.title}
                        </Text>
                        {entry.recipe.macros_per_serving.calories != null && (
                          <Text style={styles.entryMacro}>
                            {Math.round(entry.recipe.macros_per_serving.calories)} cal
                            {entry.recipe.macros_per_serving.protein_g != null &&
                              ` · ${Math.round(entry.recipe.macros_per_serving.protein_g)}g protein`}
                          </Text>
                        )}
                        <TouchableOpacity
                          style={styles.removeBtn}
                          onPress={() => handleRemoveEntry(entry.id)}
                          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                        >
                          <Ionicons name="close-circle" size={18} color="#64748b" />
                        </TouchableOpacity>
                      </View>
                    ))}
                    <TouchableOpacity
                      style={styles.addMealBtn}
                      onPress={() => handleAddMeal(dayIndex, slot)}
                    >
                      <Ionicons name="add" size={16} color="#475569" />
                    </TouchableOpacity>
                  </View>
                );
              })}
            </View>
          );
        })}
      </ScrollView>

      {/* Generate shopping list */}
      <TouchableOpacity style={styles.shoppingBtn} onPress={handleGenerateShopping}>
        <Ionicons name="cart-outline" size={20} color="#fff" />
        <Text style={styles.shoppingBtnText}>Generate Shopping List</Text>
      </TouchableOpacity>

      {/* Recipe picker modal */}
      <Modal
        visible={showRecipePicker}
        animationType="slide"
        presentationStyle="pageSheet"
        onRequestClose={() => setShowRecipePicker(false)}
      >
        <View style={styles.modal}>
          <View style={styles.modalHeader}>
            <Text style={styles.modalTitle}>Choose a Recipe</Text>
            <TouchableOpacity onPress={() => setShowRecipePicker(false)}>
              <Ionicons name="close" size={24} color="#94a3b8" />
            </TouchableOpacity>
          </View>
          <FlatList
            data={allRecipes}
            keyExtractor={(r) => String(r.id)}
            contentContainerStyle={{ padding: 16, gap: 8 }}
            renderItem={({ item }) => (
              <TouchableOpacity
                style={styles.pickerCard}
                onPress={() => handlePickRecipe(item)}
              >
                <Text style={styles.pickerTitle}>{item.title}</Text>
                <Text style={styles.pickerMeta}>
                  {item.meal_type} · {item.macros_per_serving.calories != null ? `${Math.round(item.macros_per_serving.calories)} cal` : ""}
                </Text>
              </TouchableOpacity>
            )}
          />
        </View>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a" },
  center: { flex: 1, backgroundColor: "#0f172a", alignItems: "center", justifyContent: "center" },
  headerRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    padding: 16,
  },
  weekLabel: { color: "#94a3b8", fontSize: 14 },
  aiBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#7c3aed",
    borderRadius: 8,
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
  aiBtnDisabled: { opacity: 0.5 },
  aiBtnText: { color: "#fff", fontWeight: "700", fontSize: 14 },
  calendar: { padding: 12, gap: 12, paddingBottom: 80 },
  dayBlock: { backgroundColor: "#1e293b", borderRadius: 12, overflow: "hidden" },
  dayLabel: {
    color: "#f97316",
    fontWeight: "800",
    fontSize: 15,
    padding: 12,
    paddingBottom: 4,
    backgroundColor: "#0f172a",
  },
  slotBlock: { padding: 8, paddingHorizontal: 12, gap: 4 },
  slotHeader: { flexDirection: "row", alignItems: "center", gap: 6 },
  slotLabel: { color: "#64748b", fontSize: 12, textTransform: "capitalize" },
  entryCard: {
    backgroundColor: "#0f172a",
    borderRadius: 8,
    padding: 10,
    flexDirection: "row",
    alignItems: "center",
  },
  entryTitle: { color: "#f8fafc", fontSize: 13, fontWeight: "600", flex: 1 },
  entryMacro: { color: "#64748b", fontSize: 12, marginRight: 8 },
  removeBtn: { padding: 2 },
  addMealBtn: {
    alignItems: "center",
    justifyContent: "center",
    height: 28,
    backgroundColor: "#0f172a",
    borderRadius: 6,
    borderWidth: 1,
    borderColor: "#1e293b",
    borderStyle: "dashed",
  },
  shoppingBtn: {
    position: "absolute",
    bottom: 20,
    left: 20,
    right: 20,
    backgroundColor: "#f97316",
    borderRadius: 12,
    padding: 16,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  shoppingBtnText: { color: "#fff", fontWeight: "700", fontSize: 16 },
  modal: { flex: 1, backgroundColor: "#0f172a" },
  modalHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    padding: 20,
    borderBottomWidth: 1,
    borderBottomColor: "#1e293b",
  },
  modalTitle: { color: "#f8fafc", fontSize: 18, fontWeight: "700" },
  pickerCard: {
    backgroundColor: "#1e293b",
    borderRadius: 10,
    padding: 14,
  },
  pickerTitle: { color: "#f8fafc", fontSize: 15, fontWeight: "600" },
  pickerMeta: { color: "#64748b", fontSize: 13, marginTop: 2 },
});
