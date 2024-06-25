import { FoldingRangeFeature } from "vscode-languageclient/lib/common/foldingRange";
import { DynamicFeature, LanguageClient, StaticFeature } from "vscode-languageclient/node";

export class CustomLanguageClient extends LanguageClient {
    public registerFeature(feature: StaticFeature | DynamicFeature<any>): void {
        if (feature instanceof FoldingRangeFeature) {
            return;
        }
        super.registerFeature(feature);
    }
}
