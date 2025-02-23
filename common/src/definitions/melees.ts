import { type ItemDefinition, ItemType } from "../utils/objectDefinitions";
import { v, type Vector } from "../utils/vector";
import { type FireMode } from "../constants";

export interface MeleeDefinition extends ItemDefinition {
    readonly itemType: ItemType.Melee

    readonly damage: number
    readonly obstacleMultiplier: number
    readonly piercingMultiplier?: number // If it does less dmg vs pierceable objects than it would vs a normal one
    readonly radius: number
    readonly offset: Vector
    readonly cooldown: number
    readonly fists: {
        readonly animationDuration: number
        readonly randomFist: boolean
        readonly left: Vector
        readonly right: Vector
        readonly useLeft: Vector
        readonly useRight: Vector
    }
    readonly image?: {
        readonly position: Vector
        readonly usePosition: Vector
        readonly angle?: number
        readonly useAngle?: number
        readonly lootScale?: number
    }
    readonly fireMode?: FireMode
}

export const Melees: MeleeDefinition[] = [
    {
        idString: "fists",
        name: "Fists",
        itemType: ItemType.Melee,
        damage: 20,
        obstacleMultiplier: 1,
        radius: 1.5,
        offset: v(2.5, 0),
        cooldown: 250,
        noDrop: true,
        fists: {
            animationDuration: 125,
            randomFist: true,
            left: v(38, 35),
            right: v(38, -35),
            useLeft: v(75, 10),
            useRight: v(75, -10)
        }
    },
    {
        idString: "baseball_bat",
        name: "Baseball Bat",
        itemType: ItemType.Melee,
        damage: 35,
        obstacleMultiplier: 1,
        radius: 4,
        offset: v(5.4, 1.2),
        cooldown: 450,
        fists: {
            animationDuration: 125,
            randomFist: false,
            left: v(38, 35),
            right: v(38, -35),
            useLeft: v(75, 20),
            useRight: v(38, -35)
        },
        image: {
            position: v(100, 50),
            usePosition: v(115, -15),
            angle: 60,
            useAngle: 0,
            lootScale: 0.65
        }
    },
    {
        idString: "kbar",
        name: "K-bar",
        itemType: ItemType.Melee,
        damage: 25,
        obstacleMultiplier: 1.25,
        radius: 2.7,
        offset: v(3.1, 0.9),
        cooldown: 200,
        fists: {
            animationDuration: 125,
            randomFist: false,
            left: v(38, 35),
            right: v(38, -35),
            useLeft: v(70, 20),
            useRight: v(38, -35)
        },
        image: {
            position: v(62, 42),
            usePosition: v(90, 8),
            angle: 60,
            useAngle: 5
        }
    }
];
