import { type Game } from "./game";
import { log } from "../../common/src/utils/misc";
import { type GameObject } from "./types/gameObject";
import { ObjectType } from "../../common/src/utils/objectType";
import { v, type Vector } from "../../common/src/utils/vector";
import { type Variation } from "../../common/src/typings";
import {
    random,
    randomFloat, randomPointInsideCircle,
    randomRotation,
    randomVector
} from "../../common/src/utils/random";
import { type ObstacleDefinition } from "../../common/src/definitions/obstacles";
import { CircleHitbox, type Hitbox } from "../../common/src/utils/hitbox";
import { Obstacle } from "./objects/obstacle";
import { ObjectCategory } from "../../common/src/constants";
import { Config, SpawnMode } from "./config";
import { Vec2 } from "planck";

export class Map {
    game: Game;

    readonly width = 720;
    readonly height = 720;

    constructor(game: Game) {
        const mapStartTime = Date.now();
        this.game = game;

        if (!Config.disableMapGeneration) {
            this.generateObstacles("oil_tank", 2, undefined, 200, true);
            this.generateObstacles("oil_tank", 5);
            this.generateObstacles("oak_tree", 135);
            this.generateObstacles("pine_tree", 10);
            this.generateObstacles("birch_tree", 15);
            this.generateObstacles("rock", 145);
            this.generateObstacles("bush", 80);
            this.generateObstacles("regular_crate", 155);
            this.generateObstacles("aegis_crate", 3);
            this.generateObstacles("flint_crate", 3);
            this.generateObstacles("barrel", 70);
            this.generateObstacles("super_barrel", 20);
            this.generateObstacles("gauze_crate", 1);
            this.generateObstacles("cola_crate", 1);
            this.generateObstacles("melee_crate", 1);
            this.generateObstacles("deathray_crate", 1, 0.000001);
            this.generateObstacles("gold_rock", 1);
        } else {
            // Obstacle debug code goes here
            this.obstacleTest("regular_crate", Vec2(363, 363), 0, 1, 0);
            this.obstacleTest("regular_crate", Vec2(373, 363), Math.PI / 2, 1, 0);
            this.obstacleTest("regular_crate", Vec2(383, 363), Math.PI, 1, 0);
            this.obstacleTest("regular_crate", Vec2(393, 363), -Math.PI / 2, 1, 0);
        }
        log(`Map generation took ${Date.now() - mapStartTime}ms`, true);

        // Calculate visible objects
        const visibleObjectsStartTime = Date.now();
        const supportedZoomLevels: number[] = [48, 96];

        for (const zoomLevel of supportedZoomLevels) {
            this.game.visibleObjects[zoomLevel] = {};
            const xCullDist = zoomLevel * 1.75; const yCullDist = zoomLevel * 1.35;

            for (let x = 0; x <= this.width / 10; x++) {
                this.game.visibleObjects[zoomLevel][x * 10] = {};
                for (let y = 0; y <= this.height / 10; y++) {
                    const visibleObjects = new Set<GameObject>();
                    const minX = (x * 10) - xCullDist;
                    const minY = (y * 10) - yCullDist;
                    const maxX = (x * 10) + xCullDist;
                    const maxY = (y * 10) + yCullDist;

                    for (const object of this.game.staticObjects) {
                        if (object.position.x > minX &&
                            object.position.x < maxX &&
                            object.position.y > minY &&
                            object.position.y < maxY) {
                            visibleObjects.add(object);
                        }
                    }

                    this.game.visibleObjects[zoomLevel][x * 10][y * 10] = visibleObjects;
                }
            }
        }

        log(`Calculating visible objects took ${Date.now() - visibleObjectsStartTime}ms`);
    }

    private generateObstacles(idString: string, count: number, prob?: number, radius?: number, squareRadius?: boolean): void {
        const type: ObjectType = ObjectType.fromString(ObjectCategory.Obstacle, idString);
        for (let i = 0; i < count; i++) {
            if ((prob !== undefined && Math.random() < prob) || prob === undefined) {
                const definition: ObstacleDefinition = type.definition as ObstacleDefinition;
                const scale = randomFloat(definition.scale.spawnMin, definition.scale.spawnMax);
                const variation: Variation = (definition.variations !== undefined ? random(0, definition.variations - 1) : 0) as Variation;
                let rotation: number | undefined;
                switch (definition.rotationMode) {
                    case "full":
                        rotation = randomRotation();
                        break;
                    case "limited":
                        rotation = random(0, 3);
                        break;
                    case "binary":
                        rotation = random(0, 1);
                        break;
                    case "none":
                    default:
                        rotation = 0;
                        break;
                }

                if (rotation === undefined) {
                    throw new Error("Unknown rotation type");
                }

                let position = this.getRandomPositionFor(type, scale);
                if (radius !== undefined && squareRadius !== undefined) {
                    position = this.getRandomPositionInRadiusFor(type, scale, radius, squareRadius);
                }

                const obstacle: Obstacle = new Obstacle(
                    this.game,
                    type,
                    position,
                    rotation,
                    scale,
                    variation
                );

                this.game.staticObjects.add(obstacle);
            }
        }
    }

    private obstacleTest(idString: string, position: Vec2, rotation: number, scale: number, variation: Variation): Obstacle {
        const type = ObjectType.fromString(ObjectCategory.Obstacle, idString);
        const obstacle: Obstacle = new Obstacle(
            this.game,
            type,
            position,
            rotation,
            scale,
            variation
        );
        this.game.staticObjects.add(obstacle);
        return obstacle;
    }

    getRandomPositionFor(type: ObjectType, scale = 1): Vector {
        let collided = true;
        let position: Vector = v(0, 0);
        let attempts = 0;
        let initialHitbox: Hitbox | undefined;

        // Set up the hitbox
        if (type.category === ObjectCategory.Obstacle) {
            const definition: ObstacleDefinition = type.definition as ObstacleDefinition;
            initialHitbox = definition.spawnHitbox ?? definition.hitbox;
        } else if (type.category === ObjectCategory.Player) {
            initialHitbox = new CircleHitbox(2.5);
        }
        if (initialHitbox === undefined) {
            throw new Error(`Unsupported object category: ${type.category}`);
        }

        let getPosition: () => Vector;
        if (type.category === ObjectCategory.Obstacle || (type.category === ObjectCategory.Player && Config.spawn.mode === SpawnMode.Random)) {
            getPosition = (): Vector => randomVector(12, this.width - 12, 12, this.height - 12);
        } else if (type.category === ObjectCategory.Player && Config.spawn.mode === SpawnMode.Radius) {
            const spawn = Config.spawn as { readonly mode: SpawnMode.Radius, readonly position: Vec2, readonly radius: number };
            getPosition = (): Vector => randomPointInsideCircle(spawn.position, spawn.radius);
        } else {
            getPosition = (): Vector => v(0, 0);
        }

        // Find a valid position
        while (collided && attempts <= 200) {
            attempts++;

            if (attempts >= 200) {
                console.warn(`[WARNING] Maximum spawn attempts exceeded for: ${type.idString}`);
            }

            collided = false;
            position = getPosition();

            const hitbox: Hitbox = initialHitbox.transform(position, scale);
            for (const object of this.game.staticObjects) {
                if (object instanceof Obstacle) {
                    if (object.spawnHitbox.collidesWith(hitbox)) {
                        collided = true;
                    }
                }
            }
        }

        return position;
    }

    getRandomPositionInRadiusFor(type: ObjectType, scale = 1, radius: number, squareRadius: boolean): Vector { // TODO Combine with getRandomPositionFor
        let collided = true;
        let position: Vector = v(0, 0);
        let attempts = 0;
        let initialHitbox: Hitbox | undefined;

        if (radius > this.width || radius > this.height) {
            radius = Math.min(this.width, this.height);
        }
        // Set up the hitbox
        if (type.category === ObjectCategory.Obstacle) {
            const definition: ObstacleDefinition = type.definition as ObstacleDefinition;
            initialHitbox = definition.spawnHitbox ?? definition.hitbox;
        } else if (type.category === ObjectCategory.Player) {
            initialHitbox = new CircleHitbox(2.5);
        }
        if (initialHitbox === undefined) {
            throw new Error(`Unsupported object category: ${type.category}`);
        }

        let getPosition: () => Vector;
        if (squareRadius) {
            getPosition = (): Vector => randomVector(this.width / 2 - radius, this.width / 2 + radius, this.height / 2 - radius, this.height / 2 + radius);
        } else {
            getPosition = (): Vector => randomPointInsideCircle(new Vec2(this.width / 2, this.height / 2), radius);
        }

        // Find a valid position
        while (collided && attempts <= 200) {
            attempts++;

            if (attempts >= 200) {
                console.warn(`[WARNING] Maximum spawn attempts exceeded for: ${type.idString}`);
            }

            collided = false;
            position = getPosition();

            const hitbox: Hitbox = initialHitbox.transform(position, scale);
            for (const object of this.game.staticObjects) {
                if (object instanceof Obstacle) {
                    if (object.spawnHitbox.collidesWith(hitbox)) {
                        collided = true;
                    }
                }
            }
        }

        return position;
    }
}
