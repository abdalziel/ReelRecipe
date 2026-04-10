import { Tabs } from "expo-router";
import { Ionicons } from "@expo/vector-icons";

type IconName = React.ComponentProps<typeof Ionicons>["name"];

function TabIcon({
  name,
  color,
  focused,
}: {
  name: IconName;
  color: string;
  focused: boolean;
}) {
  return (
    <Ionicons
      name={focused ? name : (`${name}-outline` as IconName)}
      size={24}
      color={color}
    />
  );
}

export default function TabsLayout() {
  return (
    <Tabs
      screenOptions={{
        tabBarStyle: {
          backgroundColor: "#1e293b",
          borderTopColor: "#334155",
        },
        tabBarActiveTintColor: "#f97316",
        tabBarInactiveTintColor: "#94a3b8",
        headerStyle: { backgroundColor: "#0f172a" },
        headerTintColor: "#f8fafc",
        headerTitleStyle: { fontWeight: "700" },
      }}
    >
      <Tabs.Screen
        name="index"
        options={{
          title: "Recipes",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="restaurant" color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="add"
        options={{
          title: "Add Reel",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="add-circle" color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="planner"
        options={{
          title: "Meal Plan",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="calendar" color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="shopping"
        options={{
          title: "Shopping",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="cart" color={color} focused={focused} />
          ),
        }}
      />
      <Tabs.Screen
        name="diet"
        options={{
          title: "Diet Goals",
          tabBarIcon: ({ color, focused }) => (
            <TabIcon name="fitness" color={color} focused={focused} />
          ),
        }}
      />
    </Tabs>
  );
}
