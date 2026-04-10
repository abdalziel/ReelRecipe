import {
  View,
  Text,
  FlatList,
  TouchableOpacity,
  StyleSheet,
  Image,
  TextInput,
  ActivityIndicator,
  RefreshControl,
  ScrollView,
} from "react-native";
import { useState, useEffect, useCallback, useMemo } from "react";
import { router } from "expo-router";
import { Ionicons } from "@expo/vector-icons";
import { recipesApi, Recipe, thumbnailUrl } from "../../lib/api";

const MEAL_TYPES = ["all", "breakfast", "lunch", "dinner", "snack"];

type SortKey = "newest" | "oldest" | "alpha" | "protein";
const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "newest",  label: "Newest" },
  { key: "oldest",  label: "Oldest" },
  { key: "alpha",   label: "A → Z" },
  { key: "protein", label: "Protein" },
];

export default function RecipesScreen() {
  const [recipes, setRecipes] = useState<Recipe[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [search, setSearch] = useState("");
  const [mealType, setMealType] = useState("all");
  const [sort, setSort] = useState<SortKey>("newest");

  const sortedRecipes = useMemo(() => {
    const arr = [...recipes];
    if (sort === "newest") arr.sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
    else if (sort === "oldest") arr.sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime());
    else if (sort === "alpha") arr.sort((a, b) => a.title.localeCompare(b.title));
    else if (sort === "protein") arr.sort((a, b) => (b.macros_per_serving?.protein_g ?? -1) - (a.macros_per_serving?.protein_g ?? -1));
    return arr;
  }, [recipes, sort]);

  const load = useCallback(async () => {
    try {
      const data = await recipesApi.list({
        ...(mealType !== "all" && { meal_type: mealType }),
        ...(search && { search }),
      });
      setRecipes(data);
    } catch (e) {
      console.error(e);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [mealType, search]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  const onRefresh = () => {
    setRefreshing(true);
    load();
  };

  const renderRecipe = ({ item }: { item: Recipe }) => (
    <TouchableOpacity
      style={styles.card}
      onPress={() => router.push(`/recipe/${item.id}`)}
      activeOpacity={0.8}
    >
      {item.thumbnail_url ? (
        <Image source={{ uri: thumbnailUrl(item.thumbnail_url) }} style={styles.thumbnail} />
      ) : (
        <View style={[styles.thumbnail, styles.placeholderThumb]}>
          <Ionicons name="restaurant" size={32} color="#475569" />
        </View>
      )}
      <View style={styles.cardBody}>
        <Text style={styles.cardTitle} numberOfLines={2}>
          {item.title}
        </Text>
        <View style={styles.cardMeta}>
          {item.meal_type && (
            <View style={styles.badge}>
              <Text style={styles.badgeText}>{item.meal_type}</Text>
            </View>
          )}
          {item.cuisine && (
            <Text style={styles.cuisine}>{item.cuisine}</Text>
          )}
        </View>
        <View style={styles.macroRow}>
          {item.macros_per_serving.calories != null && (
            <Text style={styles.macro}>{Math.round(item.macros_per_serving.calories)} cal</Text>
          )}
          {item.macros_per_serving.protein_g != null && (
            <Text style={styles.macro}>{Math.round(item.macros_per_serving.protein_g)}g protein</Text>
          )}
          {item.cook_time_minutes != null && (
            <Text style={styles.macro}>{item.cook_time_minutes} min</Text>
          )}
        </View>
      </View>
    </TouchableOpacity>
  );

  return (
    <View style={styles.container}>
      {/* Search */}
      <View style={styles.searchRow}>
        <Ionicons name="search" size={18} color="#94a3b8" style={styles.searchIcon} />
        <TextInput
          style={styles.searchInput}
          placeholder="Search recipes…"
          placeholderTextColor="#475569"
          value={search}
          onChangeText={setSearch}
          returnKeyType="search"
        />
      </View>

      {/* Meal type filter */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.filterRow}>
        {MEAL_TYPES.map((t) => (
          <TouchableOpacity
            key={t}
            style={[styles.filterChip, mealType === t && styles.filterChipActive]}
            onPress={() => setMealType(t)}
          >
            <Text style={[styles.filterText, mealType === t && styles.filterTextActive]}>
              {t.charAt(0).toUpperCase() + t.slice(1)}
            </Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {/* Sort options */}
      <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={styles.sortRow}>
        {SORT_OPTIONS.map((o) => (
          <TouchableOpacity
            key={o.key}
            style={[styles.sortChip, sort === o.key && styles.sortChipActive]}
            onPress={() => setSort(o.key)}
          >
            <Text style={[styles.sortText, sort === o.key && styles.sortTextActive]}>{o.label}</Text>
          </TouchableOpacity>
        ))}
      </ScrollView>

      {loading ? (
        <ActivityIndicator color="#f97316" style={{ marginTop: 48 }} size="large" />
      ) : recipes.length === 0 ? (
        <View style={styles.empty}>
          <Ionicons name="restaurant-outline" size={56} color="#334155" />
          <Text style={styles.emptyTitle}>No recipes yet</Text>
          <Text style={styles.emptySubtitle}>
            Tap "Add Reel" to import your first Instagram cooking reel
          </Text>
        </View>
      ) : (
        <FlatList
          data={sortedRecipes}
          keyExtractor={(r) => String(r.id)}
          renderItem={renderRecipe}
          contentContainerStyle={styles.list}
          refreshControl={
            <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor="#f97316" />
          }
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#0f172a" },
  searchRow: {
    flexDirection: "row",
    alignItems: "center",
    margin: 12,
    backgroundColor: "#1e293b",
    borderRadius: 10,
    paddingHorizontal: 12,
  },
  searchIcon: { marginRight: 8 },
  searchInput: { flex: 1, color: "#f8fafc", height: 42, fontSize: 15 },
  filterRow: {
    flexDirection: "row",
    paddingHorizontal: 12,
    paddingBottom: 8,
    gap: 8,
  },
  filterChip: {
    paddingHorizontal: 12,
    paddingVertical: 6,
    borderRadius: 20,
    backgroundColor: "#1e293b",
  },
  filterChipActive: { backgroundColor: "#f97316" },
  filterText: { color: "#94a3b8", fontSize: 13 },
  filterTextActive: { color: "#fff", fontWeight: "600" },
  sortRow: { paddingHorizontal: 12, paddingBottom: 8, gap: 8 },
  sortChip: {
    paddingHorizontal: 12,
    paddingVertical: 5,
    borderRadius: 20,
    backgroundColor: "#1e293b",
    borderWidth: 1,
    borderColor: "#334155",
  },
  sortChipActive: { backgroundColor: "#1e3a5f", borderColor: "#3b82f6" },
  sortText: { color: "#64748b", fontSize: 12 },
  sortTextActive: { color: "#93c5fd", fontWeight: "600" },
  list: { padding: 12, gap: 12 },
  card: {
    backgroundColor: "#1e293b",
    borderRadius: 14,
    flexDirection: "row",
    overflow: "hidden",
  },
  thumbnail: { width: 100, height: 100 },
  placeholderThumb: {
    backgroundColor: "#0f172a",
    alignItems: "center",
    justifyContent: "center",
  },
  cardBody: { flex: 1, padding: 12, justifyContent: "space-between" },
  cardTitle: { color: "#f8fafc", fontSize: 15, fontWeight: "600", lineHeight: 20 },
  cardMeta: { flexDirection: "row", alignItems: "center", gap: 8, marginTop: 4 },
  badge: {
    backgroundColor: "#1d4ed8",
    borderRadius: 4,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  badgeText: { color: "#bfdbfe", fontSize: 11, fontWeight: "600" },
  cuisine: { color: "#94a3b8", fontSize: 12 },
  macroRow: { flexDirection: "row", gap: 8, marginTop: 4 },
  macro: { color: "#64748b", fontSize: 12 },
  empty: { flex: 1, alignItems: "center", justifyContent: "center", padding: 32 },
  emptyTitle: { color: "#f8fafc", fontSize: 20, fontWeight: "700", marginTop: 16 },
  emptySubtitle: {
    color: "#94a3b8",
    fontSize: 14,
    textAlign: "center",
    marginTop: 8,
    lineHeight: 20,
  },
});
