import {
  View,
  Text,
  ScrollView,
  StyleSheet,
  Image,
  TouchableOpacity,
  Alert,
  ActivityIndicator,
} from "react-native";
import { useLocalSearchParams, router } from "expo-router";
import { useEffect, useState } from "react";
import { Ionicons } from "@expo/vector-icons";
import { recipesApi, Recipe } from "../../lib/api";

const CATEGORY_COLORS: Record<string, string> = {
  produce: "#16a34a",
  protein: "#dc2626",
  dairy: "#2563eb",
  pantry: "#d97706",
  frozen: "#7c3aed",
  spice: "#db2777",
  beverage: "#0891b2",
  other: "#475569",
};

export default function RecipeDetailScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const [recipe, setRecipe] = useState<Recipe | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    recipesApi
      .get(Number(id))
      .then(setRecipe)
      .catch(() => Alert.alert("Error", "Could not load recipe"))
      .finally(() => setLoading(false));
  }, [id]);

  const handleDelete = () => {
    Alert.alert("Delete Recipe", "Remove this recipe permanently?", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Delete",
        style: "destructive",
        onPress: async () => {
          await recipesApi.delete(Number(id));
          router.back();
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
  if (!recipe) return null;

  const totalTime = (recipe.prep_time_minutes ?? 0) + (recipe.cook_time_minutes ?? 0);

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      {/* Thumbnail */}
      {recipe.thumbnail_url ? (
        <Image source={{ uri: recipe.thumbnail_url }} style={styles.hero} />
      ) : (
        <View style={[styles.hero, styles.heroPlaceholder]}>
          <Ionicons name="restaurant" size={56} color="#334155" />
        </View>
      )}

      {/* Title + meta */}
      <View style={styles.section}>
        <Text style={styles.title}>{recipe.title}</Text>
        {recipe.description && (
          <Text style={styles.description}>{recipe.description}</Text>
        )}

        <View style={styles.metaRow}>
          {recipe.meal_type && (
            <View style={styles.badge}>
              <Ionicons name="time-outline" size={12} color="#bfdbfe" />
              <Text style={styles.badgeText}>{recipe.meal_type}</Text>
            </View>
          )}
          {recipe.cuisine && (
            <View style={[styles.badge, { backgroundColor: "#1d4ed8" }]}>
              <Text style={styles.badgeText}>{recipe.cuisine}</Text>
            </View>
          )}
          {totalTime > 0 && (
            <View style={[styles.badge, { backgroundColor: "#166534" }]}>
              <Ionicons name="time-outline" size={12} color="#bbf7d0" />
              <Text style={[styles.badgeText, { color: "#bbf7d0" }]}>{totalTime} min</Text>
            </View>
          )}
        </View>
      </View>

      {/* Macros */}
      {(recipe.macros_per_serving.calories != null) && (
        <View style={styles.macroCard}>
          <Text style={styles.sectionTitle}>Per Serving</Text>
          <View style={styles.macroGrid}>
            <MacroStat label="Calories" value={recipe.macros_per_serving.calories} unit="" color="#f97316" />
            <MacroStat label="Protein" value={recipe.macros_per_serving.protein_g} unit="g" color="#ef4444" />
            <MacroStat label="Carbs" value={recipe.macros_per_serving.carbs_g} unit="g" color="#eab308" />
            <MacroStat label="Fat" value={recipe.macros_per_serving.fat_g} unit="g" color="#3b82f6" />
          </View>
        </View>
      )}

      {/* Ingredients */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>
          Ingredients{recipe.servings ? ` (serves ${recipe.servings})` : ""}
        </Text>
        {recipe.ingredients.map((ing, i) => (
          <View key={i} style={styles.ingredientRow}>
            <View
              style={[
                styles.categoryDot,
                { backgroundColor: CATEGORY_COLORS[ing.category ?? "other"] ?? "#475569" },
              ]}
            />
            <Text style={styles.ingredientText}>{ing.raw_text || ing.name}</Text>
          </View>
        ))}
      </View>

      {/* Steps */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>Instructions</Text>
        {recipe.steps.map((step, i) => (
          <View key={i} style={styles.stepRow}>
            <View style={styles.stepNum}>
              <Text style={styles.stepNumText}>{i + 1}</Text>
            </View>
            <Text style={styles.stepText}>{step}</Text>
          </View>
        ))}
      </View>

      {/* Tags */}
      {recipe.tags?.length > 0 && (
        <View style={styles.tagsRow}>
          {recipe.tags.map((t) => (
            <View key={t} style={styles.tag}>
              <Text style={styles.tagText}>#{t}</Text>
            </View>
          ))}
        </View>
      )}

      {/* Delete */}
      <TouchableOpacity style={styles.deleteBtn} onPress={handleDelete}>
        <Ionicons name="trash-outline" size={18} color="#ef4444" />
        <Text style={styles.deleteBtnText}>Delete Recipe</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

function MacroStat({
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
    <View style={macroStyles.stat}>
      <Text style={[macroStyles.value, { color }]}>
        {Math.round(value)}
        <Text style={macroStyles.unit}>{unit}</Text>
      </Text>
      <Text style={macroStyles.label}>{label}</Text>
    </View>
  );
}

const macroStyles = StyleSheet.create({
  stat: { alignItems: "center", flex: 1 },
  value: { fontSize: 22, fontWeight: "800" },
  unit: { fontSize: 14, fontWeight: "400" },
  label: { color: "#64748b", fontSize: 12, marginTop: 2 },
});

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a" },
  content: { paddingBottom: 40 },
  center: { flex: 1, backgroundColor: "#0f172a", alignItems: "center", justifyContent: "center" },
  hero: { width: "100%", height: 220 },
  heroPlaceholder: { backgroundColor: "#1e293b", alignItems: "center", justifyContent: "center" },
  section: { padding: 20, gap: 8 },
  title: { color: "#f8fafc", fontSize: 22, fontWeight: "800", lineHeight: 28 },
  description: { color: "#94a3b8", fontSize: 14, lineHeight: 20 },
  metaRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  badge: {
    backgroundColor: "#1e3a5f",
    borderRadius: 6,
    paddingHorizontal: 8,
    paddingVertical: 4,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
  },
  badgeText: { color: "#bfdbfe", fontSize: 12, fontWeight: "600" },
  macroCard: {
    margin: 20,
    marginTop: 0,
    backgroundColor: "#1e293b",
    borderRadius: 14,
    padding: 16,
    gap: 12,
  },
  macroGrid: { flexDirection: "row" },
  sectionTitle: { color: "#f8fafc", fontSize: 17, fontWeight: "700", marginBottom: 4 },
  ingredientRow: { flexDirection: "row", alignItems: "center", gap: 10, paddingVertical: 4 },
  categoryDot: { width: 8, height: 8, borderRadius: 4 },
  ingredientText: { color: "#cbd5e1", fontSize: 15, flex: 1 },
  stepRow: { flexDirection: "row", gap: 12, paddingVertical: 6 },
  stepNum: {
    width: 26,
    height: 26,
    borderRadius: 13,
    backgroundColor: "#f97316",
    alignItems: "center",
    justifyContent: "center",
    marginTop: 1,
    flexShrink: 0,
  },
  stepNumText: { color: "#fff", fontWeight: "800", fontSize: 13 },
  stepText: { color: "#cbd5e1", fontSize: 15, flex: 1, lineHeight: 22 },
  tagsRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    paddingHorizontal: 20,
    gap: 8,
    marginBottom: 8,
  },
  tag: { backgroundColor: "#1e293b", borderRadius: 20, paddingHorizontal: 12, paddingVertical: 4 },
  tagText: { color: "#64748b", fontSize: 13 },
  deleteBtn: {
    margin: 20,
    borderWidth: 1,
    borderColor: "#991b1b",
    borderRadius: 10,
    padding: 14,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
  deleteBtnText: { color: "#ef4444", fontWeight: "600" },
});
